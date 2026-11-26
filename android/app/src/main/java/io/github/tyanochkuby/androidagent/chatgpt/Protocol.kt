package io.github.tyanochkuby.androidagent.chatgpt

import java.io.BufferedReader
import java.net.URLDecoder
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import kotlin.io.encoding.Base64
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

// Sign in with ChatGPT for open-source clients:
// https://developers.openai.com/siwc/token-sharing-open-source/sign-in

const val ISSUER = "https://auth.openai.com"
const val RESOURCE = "https://api.openai.com/v1"
const val SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
const val SHARING_SCOPE = "chatgpt.tokens.use.direct"
const val REGISTRATION_CLIENT = "dynamic_agent_client"
const val CALLBACK_PATH = "/auth/callback"
const val APP_NAME = "Android Agent"

/** A failure whose message is safe to show and save: it never quotes tokens or provider text. */
class ChatGPTException(val code: String, message: String, val retryable: Boolean = false) : Exception(message)

private val random = SecureRandom()
val base64Url = Base64.UrlSafe.withPadding(Base64.PaddingOption.ABSENT_OPTIONAL)

fun randomValue(): String = ByteArray(32).also(random::nextBytes).let(base64Url::encode)

/** The PKCE S256 challenge for `verifier`: base64url SHA-256 without padding. */
fun codeChallenge(verifier: String): String =
  base64Url.encode(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()))

fun form(vararg fields: Pair<String, String>) =
  fields.joinToString("&") { (key, value) -> "${encode(key)}=${encode(value)}" }

private fun encode(value: String) = URLEncoder.encode(value, "UTF-8").replace("+", "%20")

fun parseQuery(query: String?): Map<String, List<String>> =
  query.orEmpty().split('&').filter { it.isNotEmpty() }.map {
    val (key, value) = it.split('=', limit = 2).let { parts -> parts[0] to parts.getOrElse(1) { "" } }
    URLDecoder.decode(key, "UTF-8") to URLDecoder.decode(value, "UTF-8")
  }.groupBy({ it.first }, { it.second })

class Authorization(val url: String, val state: String, val nonce: String, val verifier: String)

/**
 * The authorization request. `clientId` is the saved registration, or null to register this app.
 * `loginHint` names the account a saved registration belongs to. `reconsent` asks again for
 * plan usage after the user declined it.
 */
fun authorization(
  endpoint: String,
  redirectUri: String,
  clientId: String?,
  hostId: String,
  loginHint: String?,
  reconsent: Boolean,
): Authorization {
  val state = randomValue()
  val nonce = randomValue()
  val verifier = randomValue()
  val fields = buildList {
    add("client_id" to (clientId ?: REGISTRATION_CLIENT))
    add("response_type" to "code")
    add("redirect_uri" to redirectUri)
    add("scope" to SCOPES)
    add("resource" to RESOURCE)
    add("state" to state)
    add("nonce" to nonce)
    add("code_challenge_method" to "S256")
    add("code_challenge" to codeChallenge(verifier))
    add("ext_agent_host_id" to hostId)
    if (clientId == null) add("agent_name_hint" to APP_NAME)
    if (loginHint != null) add("login_hint" to loginHint)
    if (reconsent) add("prompt" to "consent")
  }
  return Authorization("$endpoint?${form(*fields.toTypedArray())}", state, nonce, verifier)
}

/**
 * Validates the loopback callback and returns the code and issued client ID.
 * The caller has already matched `state`.
 */
fun callbackResult(query: Map<String, List<String>>, savedClientId: String?): Pair<String, String> {
  query["error"]?.firstOrNull()?.let { throw oauthError(it) }
  val code = query["code"]?.singleOrNull()
  val returned = query["client_id"]
  val clientId = returned?.singleOrNull() ?: savedClientId
  if (code.isNullOrEmpty() || (returned != null && returned.size != 1) || clientId == null ||
    !clientId.matches(CLIENT_ID) || clientId == REGISTRATION_CLIENT ||
    (savedClientId != null && returned != null && clientId != savedClientId)
  ) {
    throw ChatGPTException("registration_incomplete", "ChatGPT did not complete app registration. Try signing in again.")
  }
  return code to clientId
}

private val CLIENT_ID = Regex("[A-Za-z0-9_-]{1,200}")

class Tokens(
  val accessToken: String,
  val refreshToken: String,
  val expiresAt: Long,
  val earliestRefreshAt: Long?,
  val scopes: List<String>,
  val idToken: String?,
)

/** Reads a token response. A refresh may omit `scope` when the grant is unchanged. */
fun tokens(body: JsonObject, now: Long, previousScopes: List<String>? = null): Tokens {
  val scope = body.string("scope")
  val accessToken = body.string("access_token")
  val refreshToken = body.string("refresh_token")
  val expiresIn = (body["expires_in"] as? JsonPrimitive)?.longOrNull
  if ((scope == null && previousScopes == null) || accessToken.isNullOrEmpty() || refreshToken.isNullOrEmpty() ||
    !body.string("token_type").equals("bearer", ignoreCase = true) || expiresIn == null || expiresIn <= 0
  ) {
    throw ChatGPTException("invalid_token_response", "ChatGPT returned incomplete credentials. Sign in again.")
  }
  val earliest = (body["earliest_refresh_at"] as? JsonPrimitive)?.let { it.longOrNull ?: it.contentOrNull?.toLongOrNull() }
  return Tokens(
    accessToken,
    refreshToken,
    now + expiresIn * 1000,
    earliest?.times(1000),
    scope?.split(Regex("\\s+"))?.filter { it.isNotEmpty() } ?: previousScopes!!,
    body.string("id_token"),
  )
}

private val messages = mapOf(
  "subscription_sharing_user_not_eligible" to "ChatGPT plan usage is not available for this account or workspace.",
  "subscription_sharing_usage_limit_exceeded" to "A ChatGPT usage limit was reached. Check chatgpt.com/settings/usage.",
  "subscription_sharing_usage_unavailable" to "ChatGPT usage could not be checked. Try again shortly.",
  "subscription_sharing_unsupported_capability" to "This request uses something ChatGPT plan usage does not support.",
  "subscription_sharing_route_not_supported" to "ChatGPT plan usage does not support this request.",
  "subscription_sharing_invalid_user" to "ChatGPT could not validate this account. Sign in with ChatGPT again.",
  "subscription_sharing_user_unavailable" to "Your ChatGPT account is temporarily unavailable. Try again shortly.",
  "chatpass_v2_scope_not_authorized" to "The ChatGPT sign-in does not allow this request. Sign in again and allow plan usage.",
  "chatpass_v2_invalid_authorization_context" to "The ChatGPT sign-in does not allow this request. Sign in again and allow plan usage.",
  "invalid_client" to "ChatGPT rejected this app's registration. Sign in with another account to register again.",
  "invalid_grant" to "ChatGPT did not accept the sign-in. Sign in with ChatGPT again.",
  "access_denied" to "Sign-in was not completed.",
  "model_not_found" to "The selected model is not available for this ChatGPT account. Sign in again.",
)

private val retryable = setOf(
  "subscription_sharing_usage_unavailable",
  "subscription_sharing_user_unavailable",
)

// Refresh errors that mean the refresh token can never be used again.
val reauthenticationCodes = setOf(
  "invalid_grant", "invalid_refresh_token", "token_expired",
  "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused",
)

fun oauthError(code: String) = apiError(JsonObject(mapOf("error" to JsonPrimitive(code))), null)

/**
 * Maps an OAuth or Responses error body to a safe message. Provider messages can quote the request,
 * so only machine-readable codes are read.
 */
fun apiError(body: JsonElement?, status: Int?): ChatGPTException {
  var detail = body as? JsonObject ?: JsonObject(emptyMap())
  while (true) detail = (detail["error"] as? JsonObject) ?: (detail["detail"] as? JsonObject) ?: break
  val code = (detail.string("code") ?: detail.string("error"))
    ?.takeIf { it.matches(Regex("[A-Za-z0-9_][A-Za-z0-9_.:-]{0,99}")) }
    ?: "api_error"
  messages[code]?.let { return ChatGPTException(code, it, code in retryable) }
  if (code in reauthenticationCodes) return ChatGPTException(code, "Your ChatGPT sign-in expired. Sign in with ChatGPT again.")
  return when {
    status == 401 -> ChatGPTException(code, "ChatGPT did not accept this sign-in. Sign in with ChatGPT again.")
    status == 403 -> ChatGPTException(code, "A ChatGPT policy or region restriction blocked this request.")
    status == 429 -> ChatGPTException(code, "Too many ChatGPT requests. Wait a moment and try again.", true)
    status != null && status >= 500 -> ChatGPTException(code, "ChatGPT is temporarily unavailable. Try again shortly.", true)
    status == 400 || status == 422 -> ChatGPTException(code, "ChatGPT rejected the request (${code}).")
    else -> ChatGPTException(code, "ChatGPT could not complete the request (${code}).")
  }
}

class Model(val slug: String, val contextWindow: Int?)

/** The first listed model of the account's catalog, with its context window when stated. */
fun firstModel(body: JsonElement): Model {
  val models = (body as? JsonObject)?.get("models") as? JsonArray
    ?: throw ChatGPTException("invalid_model_catalog", "ChatGPT returned an unexpected model list. Try again.", true)
  val listed = models.mapNotNull { it as? JsonObject }.firstOrNull {
    it.string("visibility") == "list" && !it.string("slug").isNullOrBlank()
  } ?: throw ChatGPTException("no_models", "This ChatGPT account has no available models.")
  val window = (listed["context_window"] as? JsonPrimitive)?.intOrNull?.takeIf { it > 0 }
  return Model(listed.string("slug")!!, window)
}

/** The Responses request body. This flow requires `store: false` and `stream: true`. */
fun responsesBody(model: String, instructions: String, input: JsonArray) = buildJsonObject {
  put("model", model)
  put("instructions", instructions)
  put("input", buildJsonArray {
    input.forEach { message ->
      val fields = message.jsonObject
      add(buildJsonObject {
        put("role", fields.string("role"))
        put("content", fields.string("content"))
      })
    }
  })
  put("store", false)
  put("stream", true)
}.toString()

class Reply(val text: String, val inputTokens: Int?)

/** Reads a Responses event stream until `response.completed`, with the reported input tokens. */
fun readResponseStream(reader: BufferedReader): Reply {
  val text = StringBuilder()
  val data = StringBuilder()
  var inputTokens: Int? = null
  fun dispatch(): Boolean {
    if (data.isEmpty()) return false
    val event = runCatching { Json.parseToJsonElement(data.toString()) as? JsonObject }.getOrNull()
    data.clear()
    event ?: return false
    when (event.string("type")) {
      "response.output_text.delta" -> event.string("delta")?.let {
        text.append(it)
        if (text.length > 1_000_000) throw ChatGPTException("response_too_large", "The ChatGPT reply was too large.")
      }
      "response.completed" -> {
        val usage = (event["response"] as? JsonObject)?.get("usage") as? JsonObject
        inputTokens = (usage?.get("input_tokens") as? JsonPrimitive)?.intOrNull
        return true
      }
      "response.failed" -> throw apiError(event["response"], null)
      "error" -> throw apiError(event, null)
      "response.incomplete" -> throw ChatGPTException("response_incomplete", "ChatGPT stopped before finishing the reply. Try again.", true)
    }
    return false
  }
  while (true) {
    val line = reader.readLine() ?: break
    when {
      line.isEmpty() -> if (dispatch()) return Reply(text.toString(), inputTokens)
      line.startsWith("data:") -> {
        if (data.isNotEmpty()) data.append('\n')
        data.append(line.removePrefix("data:").removePrefix(" "))
      }
    }
  }
  if (dispatch()) return Reply(text.toString(), inputTokens)
  throw ChatGPTException("stream_interrupted", "The ChatGPT reply was interrupted. Try again.", true)
}

fun JsonObject.string(key: String) = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
