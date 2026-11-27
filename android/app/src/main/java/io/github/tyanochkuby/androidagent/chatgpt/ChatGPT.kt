package io.github.tyanochkuby.androidagent.chatgpt

import android.content.Context
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

private const val AUTHORIZE_URL = "$ISSUER/api/accounts/authorize"
private const val TOKEN_URL = "$ISSUER/api/accounts/oauth/token"
private const val REVOKE_URL = "$ISSUER/api/accounts/oauth/revoke"
private const val JWKS_URL = "$ISSUER/.well-known/jwks.json"
private const val SIGN_IN_TIMEOUT_MS = 10 * 60_000L
private const val REFRESH_MARGIN_MS = 60_000L

/** A ready sign-in: `account` is the stable ChatGPT subject, `contextWindow` null when unstated. */
@Serializable
class Connection(val account: String, val email: String?, val contextWindow: Int?)

/** The saved account: signed in, or signed out by ChatGPT and waiting for the same account again. */
@Serializable
class Status(val account: String, val email: String?, val signedIn: Boolean)

/**
 * Signs in with ChatGPT on this device and answers prompts on the account's plan.
 * Credentials never leave this class, and no token or reply text is logged.
 */
/** [screenshot] reads a stored screenshot by owner and ID for image input. */
class ChatGPT(
  context: Context,
  private val screenshot: (owner: String, id: String) -> ByteArray? = { _, _ -> null },
  private val clock: () -> Long = System::currentTimeMillis,
) {
  private val vault = Vault(context)
  // Serializes refreshes and account changes, so a rotated refresh token is used once.
  private val lock = Mutex()
  private val signInLock = Mutex()
  @Volatile private var cancelled = false

  suspend fun status(): Status? {
    val account = vault.read()
    val subject = account.subject ?: return null
    return if (account.session != null || account.reauthRequired) Status(subject, account.email, account.session != null) else null
  }

  /** Opens the browser with `open`, waits for the loopback callback and connects the account. */
  suspend fun signIn(open: suspend (String) -> Unit): Connection {
    if (!signInLock.tryLock()) throw ChatGPTException("sign_in_open", "Sign-in is already open in the browser.")
    try {
      cancelled = false
      return withTimeout(SIGN_IN_TIMEOUT_MS) { authorize(open) }
    } catch (_: TimeoutCancellationException) {
      throw ChatGPTException("sign_in_timeout", "Sign-in timed out. Try again.")
    } finally {
      signInLock.unlock()
    }
  }

  /** Ends a sign-in waiting for the browser. */
  fun cancelSignIn() {
    cancelled = true
  }

  /** Connects the saved sign-in without the browser, refreshing it when needed. */
  suspend fun connect(): Connection = authorized { account, token ->
    val model = firstModel(get("$RESOURCE/models", token))
    lock.withLock {
      val latest = vault.read()
      vault.write(latest.copy(model = model.slug, contextWindow = model.contextWindow))
    }
    Connection(account.subject!!, account.email, model.contextWindow)
  }

  /**
   * Answers `input` for `subject`, which must still be the signed-in account.
   * Returns null input tokens when the reply did not report usage.
   */
  suspend fun respond(
    subject: String, instructions: String, input: String, canSendScreen: () -> Boolean, canSendHistory: () -> Boolean,
  ): Reply = authorized { account, token ->
    if (account.subject != subject) {
      throw ChatGPTException("account_changed", "The ChatGPT account changed. Continue with ChatGPT again.")
    }
    val model = account.model ?: throw ChatGPTException("not_connected", "Continue with ChatGPT in Android Agent.")
    val messages = Json.parseToJsonElement(input) as JsonArray
    val containsScreen = messages.any {
      it.jsonObject["screenData"]?.jsonPrimitive?.booleanOrNull == true || it.jsonObject["screenshot"] != null
    }
    val body = responsesBody(model, instructions, messages) {
      screenshot("chatgpt:$subject", it)
    }
    withContext(Dispatchers.IO) {
      if (!canSendHistory()) {
        throw ChatGPTException("history_sharing_off", "Sharing earlier conversation is off.")
      }
      if (containsScreen && !canSendScreen()) {
        throw ChatGPTException("screen_sharing_off", "Screen sharing was turned off.")
      }
      request("$RESOURCE/responses", token, body) { readResponseStream(it.inputStream.bufferedReader()) }
    }
  }

  /**
   * Removes the local credentials and revokes the refresh token. Returns false when ChatGPT did not
   * confirm the revocation, in which case the user should disconnect the app in ChatGPT Settings.
   */
  suspend fun signOut(): Boolean = withContext(NonCancellable) {
    val account = lock.withLock {
      vault.read().also { vault.write(it.copy(session = null, reauthRequired = false)) }
    }
    val session = account.session ?: return@withContext true
    revoke(session.refreshToken, account.clientId!!)
  }

  private suspend fun authorize(open: suspend (String) -> Unit): Connection {
    val saved = vault.read()
    if (saved.session != null) throw ChatGPTException("signed_in", "You are already signed in with ChatGPT.")
    Loopback().use { loopback ->
      val request = authorization(
        AUTHORIZE_URL, loopback.redirectUri, saved.clientId, saved.hostId,
        saved.email.takeIf { saved.clientId != null }, saved.planUsageDeclined,
      )
      open(request.url)
      val (code, issued) = callbackResult(loopback.await(request.state) { cancelled }, saved.clientId)
      // A new sign-in attempt reuses the registration if the exchange fails.
      if (saved.clientId == null) lock.withLock { vault.write(vault.read().copy(clientId = issued)) }
      val exchange = post(
        TOKEN_URL,
        form(
          "grant_type" to "authorization_code", "client_id" to issued, "code" to code,
          "code_verifier" to request.verifier, "redirect_uri" to loopback.redirectUri, "resource" to RESOURCE,
        ),
      )
      if (exchange.status !in 200..299) {
        throw apiError(exchange.body, exchange.status)
      }
      return finishSignIn(exchange.body as? JsonObject ?: JsonObject(emptyMap()), issued, request.nonce)
    }
  }

  private suspend fun finishSignIn(body: JsonObject, clientId: String, nonce: String): Connection {
    val tokens = tokens(body, clock())
    val identity = verifyIdToken(
      tokens.idToken ?: throw ChatGPTException("invalid_id_token", "ChatGPT returned no identity. Sign in again."),
      get(JWKS_URL, null) as? JsonObject ?: JsonObject(emptyMap()),
      clientId, nonce, clock(),
    )
    val previous = vault.read()
    val declined = SHARING_SCOPE !in tokens.scopes
    if ((previous.subject != null && previous.subject != identity.subject) || declined) {
      revoke(tokens.refreshToken, clientId)
      if (declined) {
        lock.withLock { vault.write(vault.read().copy(planUsageDeclined = true)) }
        throw ChatGPTException("plan_usage_declined", "Allow ChatGPT plan usage when you sign in.")
      }
      throw ChatGPTException("account_mismatch", "This sign-in returned a different ChatGPT account. Choose the original account.")
    }
    lock.withLock {
      vault.write(
        vault.read().copy(
          clientId = clientId, subject = identity.subject, email = identity.email ?: previous.email,
          planUsageDeclined = false, reauthRequired = false,
          session = Session(tokens.accessToken, tokens.refreshToken, tokens.expiresAt, tokens.earliestRefreshAt, tokens.scopes),
        ),
      )
    }
    return connect()
  }

  /** Runs `call` with a fresh access token, refreshing once more if ChatGPT rejects it. */
  private suspend fun <T> authorized(call: suspend (Account, String) -> T): T {
    var (account, session) = fresh(null)
    suspend fun dispatch(account: Account, session: Session): T {
      if (SHARING_SCOPE !in session.scopes) {
        throw ChatGPTException("plan_usage_declined", "Allow ChatGPT plan usage when you sign in.")
      }
      return call(account, session.accessToken)
    }
    return try {
      dispatch(account, session)
    } catch (_: Unauthorized) {
      fresh(session.accessToken).let { (latest, refreshed) ->
        account = latest
        session = refreshed
      }
      try {
        dispatch(account, session)
      } catch (_: Unauthorized) {
        withContext(NonCancellable) {
          lock.withLock {
            val saved = vault.read()
            if (saved.subject == account.subject && saved.session == session) {
              vault.write(saved.copy(session = null, reauthRequired = true))
            }
          }
        }
        throw ChatGPTException("unauthorized", "ChatGPT did not accept this sign-in. Sign in with ChatGPT again.")
      }
    }
  }

  /**
   * Returns the saved session, refreshed when it is near expiry or when `rejected` is still its
   * access token. A refresh finishes even if the caller is cancelled.
   */
  private suspend fun fresh(rejected: String?): Pair<Account, Session> = lock.withLock {
    val account = vault.read()
    val session = account.session ?: throw if (account.reauthRequired) {
      ChatGPTException("reauth_required", "Your ChatGPT sign-in expired. Sign in with ChatGPT again.")
    } else {
      ChatGPTException("signed_out", "Sign in with ChatGPT in Android Agent.")
    }
    val now = clock()
    val due = if (rejected != null) rejected == session.accessToken
    else session.expiresAt - now <= REFRESH_MARGIN_MS && (session.earliestRefreshAt ?: 0) <= now
    if (!due) return@withLock account to session
    try {
      withContext(NonCancellable) { withTimeout(60_000) { refresh(account, session) } }
    } catch (_: TimeoutCancellationException) {
      throw ChatGPTException("refresh_timeout", "ChatGPT did not renew the sign-in in time. Try again.", true)
    }
  }

  private suspend fun refresh(account: Account, session: Session): Pair<Account, Session> {
    val clientId = account.clientId!!
    val result = post(
      TOKEN_URL,
      form("grant_type" to "refresh_token", "client_id" to clientId, "refresh_token" to session.refreshToken, "resource" to RESOURCE),
    )
    if (result.status !in 200..299) {
      val error = apiError(result.body, result.status)
      if (error.code in reauthenticationCodes) {
        vault.write(account.copy(session = null, reauthRequired = true))
        throw ChatGPTException(error.code, "Your ChatGPT sign-in expired. Sign in with ChatGPT again.")
      }
      throw error
    }
    val tokens = tokens(result.body as? JsonObject ?: JsonObject(emptyMap()), clock(), session.scopes)
    if (SHARING_SCOPE !in tokens.scopes) {
      vault.write(account.copy(session = null, reauthRequired = true))
      throw ChatGPTException("plan_usage_declined", "Allow ChatGPT plan usage when you sign in.")
    }
    val next = Session(tokens.accessToken, tokens.refreshToken, tokens.expiresAt, tokens.earliestRefreshAt, tokens.scopes)
    tokens.idToken?.let { idToken ->
      // Rotation spends the previous refresh token. Require a fresh sign-in if verification fails.
      vault.write(account.copy(session = null, reauthRequired = true))
      val identity = verifyIdToken(
        idToken, get(JWKS_URL, null) as? JsonObject ?: JsonObject(emptyMap()), clientId, null, clock(),
      )
      if (identity.subject != account.subject) {
        throw ChatGPTException("account_mismatch", "The ChatGPT identity changed. Sign in to the original account again.")
      }
    }
    val updated = account.copy(session = next)
    vault.write(updated)
    return updated to next
  }

  private suspend fun revoke(refreshToken: String, clientId: String): Boolean {
    repeat(2) {
      val status = runCatching {
        post(REVOKE_URL, form("token" to refreshToken, "token_type_hint" to "refresh_token", "client_id" to clientId)).status
      }.getOrNull()
      if (status == 200) return true
      if (status != null && status < 500) return false
    }
    return false
  }

  private class HttpResult(val status: Int, val body: JsonElement?)

  private class Unauthorized : Exception()

  private suspend fun post(url: String, body: String) = withContext(Dispatchers.IO) {
    exchange(url, "POST", body)
  }

  private suspend fun get(url: String, token: String?): JsonElement = withContext(Dispatchers.IO) {
    if (token == null) {
      val result = exchange(url, "GET", null)
      if (result.status !in 200..299) throw apiError(result.body, result.status)
      return@withContext result.body ?: throw ChatGPTException("invalid_reply", "ChatGPT sent an unexpected reply. Try again.", true)
    }
    request(url, token, null) { connection ->
      Json.parseToJsonElement(connection.inputStream.bufferedReader().use { it.readText() })
    }
  }

  /** An authorized API call. Throws [Unauthorized] on 401 so the caller can refresh and retry. */
  private fun <T> request(url: String, token: String, body: String?, read: (HttpURLConnection) -> T): T {
    val connection = open(url, if (body == null) "GET" else "POST")
    try {
      connection.setRequestProperty("Authorization", "Bearer $token")
      if (body != null) {
        connection.setRequestProperty("Content-Type", "application/json")
        connection.setRequestProperty("Accept", "text/event-stream")
        connection.readTimeout = 180_000
        send(connection, body)
      }
      val status = connection.responseCode
      if (status == 401) throw Unauthorized()
      if (status !in 200..299) throw apiError(errorBody(connection), status)
      return read(connection)
    } catch (_: IOException) {
      throw ChatGPTException("network", "Could not reach ChatGPT. Check the connection and try again.", true)
    } finally {
      connection.disconnect()
    }
  }

  /** An unauthenticated OAuth call; `body` is a form. */
  private fun exchange(url: String, method: String, body: String?): HttpResult {
    val connection = open(url, method)
    try {
      if (body != null) {
        connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
        send(connection, body)
      }
      val status = connection.responseCode
      val reply = if (status in 200..299) connection.inputStream.bufferedReader().use { it.readText() } else null
      return HttpResult(status, reply?.let { runCatching { Json.parseToJsonElement(it) }.getOrNull() } ?: errorBody(connection))
    } catch (_: IOException) {
      throw ChatGPTException("network", "Could not reach ChatGPT. Check the connection and try again.", true)
    } finally {
      connection.disconnect()
    }
  }

  private fun open(url: String, method: String) = (URL(url).openConnection() as HttpURLConnection).apply {
    requestMethod = method
    instanceFollowRedirects = false
    connectTimeout = 30_000
    readTimeout = 60_000
    useCaches = false
    setRequestProperty("Accept", "application/json")
  }

  private fun send(connection: HttpURLConnection, body: String) {
    val bytes = body.toByteArray()
    connection.doOutput = true
    connection.setFixedLengthStreamingMode(bytes.size)
    connection.outputStream.use { it.write(bytes) }
  }

  private fun errorBody(connection: HttpURLConnection): JsonElement? = runCatching {
    connection.errorStream?.bufferedReader()?.use { Json.parseToJsonElement(it.readText()) }
  }.getOrNull()
}
