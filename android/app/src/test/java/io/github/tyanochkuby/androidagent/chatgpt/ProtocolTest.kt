package io.github.tyanochkuby.androidagent.chatgpt

import java.math.BigInteger
import java.net.Socket
import java.net.URI
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.RSAPublicKey
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ProtocolTest {
  @Test
  fun `code challenge matches the RFC 7636 example`() {
    assertEquals(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    )
  }

  @Test
  fun `registration asks for plan usage on the exact loopback redirect`() {
    val request = authorization("https://auth.example/authorize", "http://127.0.0.1:4321/auth/callback", null, "urn:uuid:1", null, false)
    val query = parseQuery(URI(request.url).rawQuery).mapValues { it.value.single() }
    assertEquals(REGISTRATION_CLIENT, query["client_id"])
    assertEquals("http://127.0.0.1:4321/auth/callback", query["redirect_uri"])
    assertEquals(SCOPES, query["scope"])
    assertEquals(RESOURCE, query["resource"])
    assertEquals(codeChallenge(request.verifier), query["code_challenge"])
    assertEquals("S256", query["code_challenge_method"])
    assertEquals(request.state, query["state"])
    assertEquals(request.nonce, query["nonce"])
    assertEquals(APP_NAME, query["agent_name_hint"])
    assertNull(query["prompt"])
  }

  @Test
  fun `a saved registration names its account and can ask for consent again`() {
    val request = authorization("https://auth.example/authorize", "http://127.0.0.1:1/auth/callback", "oaiapp_1", "urn:uuid:1", "a@b.c", true)
    val query = parseQuery(URI(request.url).rawQuery).mapValues { it.value.single() }
    assertEquals("oaiapp_1", query["client_id"])
    assertEquals("a@b.c", query["login_hint"])
    assertEquals("consent", query["prompt"])
    assertNull(query["agent_name_hint"])
  }

  @Test
  fun `callback returns the code and issued client`() {
    assertEquals("c" to "oaiapp_1", callbackResult(mapOf("code" to listOf("c"), "client_id" to listOf("oaiapp_1")), null))
    assertEquals("c" to "oaiapp_1", callbackResult(mapOf("code" to listOf("c")), "oaiapp_1"))
  }

  @Test
  fun `callback rejects denial and invalid or changed registrations`() {
    assertEquals("access_denied", assertThrows(ChatGPTException::class.java) {
      callbackResult(mapOf("error" to listOf("access_denied")), null)
    }.code)
    listOf(
      mapOf("code" to listOf("c")) to null,
      mapOf("code" to listOf("c"), "client_id" to listOf(REGISTRATION_CLIENT)) to null,
      mapOf("code" to listOf("c"), "client_id" to listOf("bad id")) to null,
      mapOf("code" to listOf("c"), "client_id" to listOf("oaiapp_2")) to "oaiapp_1",
      mapOf("client_id" to listOf("oaiapp_1")) to null,
    ).forEach { (query, saved) ->
      assertEquals("registration_incomplete", assertThrows(ChatGPTException::class.java) { callbackResult(query, saved) }.code)
    }
  }

  @Test
  fun `token response keeps the previous scopes on refresh`() {
    val body = Json.parseToJsonElement(
      """{"access_token":"a","refresh_token":"r","token_type":"Bearer","expires_in":3600,"earliest_refresh_at":"100"}""",
    ).jsonObject
    val tokens = tokens(body, 1_000, listOf("openid"))
    assertEquals(3_601_000L, tokens.expiresAt)
    assertEquals(100_000L, tokens.earliestRefreshAt)
    assertEquals(listOf("openid"), tokens.scopes)
    assertThrows(ChatGPTException::class.java) { tokens(body, 1_000) }
  }

  @Test
  fun `errors map codes without echoing provider text`() {
    val error = apiError(
      Json.parseToJsonElement("""{"error":{"code":"subscription_sharing_usage_limit_exceeded","message":"secret prompt"}}"""),
      429,
    )
    assertEquals("subscription_sharing_usage_limit_exceeded", error.code)
    assertFalse(error.message!!.contains("secret"))
    assertEquals("invalid_grant", apiError(Json.parseToJsonElement("""{"error":"invalid_grant"}"""), 400).code)
    assertTrue(apiError(null, 503).retryable)
  }

  @Test
  fun `first listed model carries its context window`() {
    val model = firstModel(
      Json.parseToJsonElement(
        """{"models":[{"slug":"hidden","visibility":"hide"},{"slug":"gpt","visibility":"list","context_window":272000}]}""",
      ),
    )
    assertEquals("gpt", model.slug)
    assertEquals(272_000, model.contextWindow)
  }

  @Test
  fun `response stream joins deltas and reports usage`() {
    val stream = """
      event: response.output_text.delta
      data: {"type":"response.output_text.delta","delta":"Hel"}

      data: {"type":"response.output_text.delta","delta":"lo"}

      data: {"type":"response.completed","response":{"usage":{"input_tokens":42}}}

    """.trimIndent()
    val reply = readResponseStream(stream.reader().buffered())
    assertEquals("Hello", reply.text)
    assertEquals(42, reply.inputTokens)
  }

  @Test
  fun `response stream fails when cut short or failed`() {
    assertEquals("stream_interrupted", assertThrows(ChatGPTException::class.java) {
      readResponseStream("data: {\"type\":\"response.output_text.delta\",\"delta\":\"x\"}\n\n".reader().buffered())
    }.code)
    assertEquals("model_not_found", assertThrows(ChatGPTException::class.java) {
      readResponseStream("data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"model_not_found\"}}}\n\n".reader().buffered())
    }.code)
  }

  private val keys = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
  private val jwks = buildJsonObject {
    val key = keys.public as RSAPublicKey
    put("keys", buildJsonArray {
      add(buildJsonObject {
        put("kty", "RSA")
        put("kid", "k1")
        put("n", base64Url.encode(key.modulus.unsigned()))
        put("e", base64Url.encode(key.publicExponent.unsigned()))
      })
    })
  }

  private fun BigInteger.unsigned() = toByteArray().dropWhile { it == 0.toByte() }.toByteArray()

  private fun idToken(claims: JsonObject): String {
    val header = base64Url.encode("""{"alg":"RS256","kid":"k1"}""".toByteArray())
    val payload = base64Url.encode(claims.toString().toByteArray())
    val signature = Signature.getInstance("SHA256withRSA").run {
      initSign(keys.private)
      update("$header.$payload".toByteArray())
      sign()
    }
    return "$header.$payload.${base64Url.encode(signature)}"
  }

  private fun claims(nonce: String = "n", audience: String = "oaiapp_1") = buildJsonObject {
    put("iss", ISSUER)
    put("aud", audience)
    put("sub", "user-1")
    put("email", "a@b.c")
    put("nonce", nonce)
    put("iat", 1_000)
    put("exp", 4_600)
  }

  @Test
  fun `id token names the verified account`() {
    val identity = verifyIdToken(idToken(claims()), jwks, "oaiapp_1", "n", 2_000_000)
    assertEquals("user-1", identity.subject)
    assertEquals("a@b.c", identity.email)
  }

  @Test
  fun `id token rejects another nonce, audience, expiry or signature`() {
    listOf(
      { verifyIdToken(idToken(claims(nonce = "other")), jwks, "oaiapp_1", "n", 2_000_000) },
      { verifyIdToken(idToken(claims(audience = "oaiapp_2")), jwks, "oaiapp_1", "n", 2_000_000) },
      { verifyIdToken(idToken(claims()), jwks, "oaiapp_1", "n", 5_000_000) },
      { verifyIdToken(idToken(claims()).dropLast(4) + "AAAA", jwks, "oaiapp_1", "n", 2_000_000) },
    ).forEach { check ->
      assertEquals("invalid_id_token", assertThrows(ChatGPTException::class.java) { check() }.code)
    }
  }

  @Test
  fun `loopback ignores requests without the state and returns the callback`() = runBlocking {
    Loopback().use { loopback ->
      val port = URI(loopback.redirectUri).port
      val result = async(Dispatchers.IO) { loopback.await("expected") { false } }
      assertTrue(send(port, "/auth/callback?state=wrong&code=c", "127.0.0.1:$port").startsWith("HTTP/1.1 400"))
      assertTrue(send(port, "/auth/callback?state=expected&code=c", "localhost:$port").startsWith("HTTP/1.1 400"))
      assertTrue(send(port, "/other?state=expected&code=c", "127.0.0.1:$port").startsWith("HTTP/1.1 400"))
      assertTrue(send(port, "/auth/callback?state=expected&code=c", "127.0.0.1:$port").startsWith("HTTP/1.1 200"))
      assertEquals(listOf("c"), withTimeout(5_000) { result.await() }["code"])
    }
  }

  @Test
  fun `loopback stops when sign-in is cancelled`() = runBlocking {
    Loopback().use { loopback ->
      assertEquals("sign_in_cancelled", assertThrows(ChatGPTException::class.java) {
        runBlocking { loopback.await("expected") { true } }
      }.code)
    }
  }

  private fun send(port: Int, target: String, host: String) = Socket("127.0.0.1", port).use { socket ->
    socket.getOutputStream().write("GET $target HTTP/1.1\r\nHost: $host\r\n\r\n".toByteArray())
    socket.getInputStream().bufferedReader().readLine()
  }
}
