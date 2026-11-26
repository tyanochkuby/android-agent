package io.github.tyanochkuby.androidagent.chatgpt

import java.math.BigInteger
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.RSAPublicKeySpec
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull

class Identity(val subject: String, val email: String?)

private const val CLOCK_TOLERANCE_SECONDS = 5

/**
 * Verifies an RS256 ID token against the issuer's JWKS and returns the account it names.
 * `nonce` is checked on sign-in; refreshed tokens carry none to check.
 */
fun verifyIdToken(token: String, jwks: JsonObject, clientId: String, nonce: String?, now: Long): Identity {
  fun invalid(): Nothing = throw ChatGPTException("invalid_id_token", "ChatGPT returned an identity that could not be verified. Sign in again.")
  val parts = token.split('.')
  if (parts.size != 3) invalid()
  val header = runCatching { decodeObject(parts[0]) }.getOrNull() ?: invalid()
  val claims = runCatching { decodeObject(parts[1]) }.getOrNull() ?: invalid()
  if (header.string("alg") != "RS256") invalid()
  val kid = header.string("kid")
  val key = (jwks["keys"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }.firstOrNull {
    it.string("kty") == "RSA" && (kid == null || it.string("kid") == kid) && it.string("use").let { use -> use == null || use == "sig" }
  } ?: invalid()
  val verified = runCatching {
    val modulus = BigInteger(1, base64Url.decode(key.string("n")!!))
    val exponent = BigInteger(1, base64Url.decode(key.string("e")!!))
    Signature.getInstance("SHA256withRSA").run {
      initVerify(KeyFactory.getInstance("RSA").generatePublic(RSAPublicKeySpec(modulus, exponent)))
      update("${parts[0]}.${parts[1]}".toByteArray())
      verify(base64Url.decode(parts[2]))
    }
  }.getOrDefault(false)
  if (!verified) invalid()

  val seconds = now / 1000
  val audience = when (val aud = claims["aud"]) {
    is JsonArray -> aud.mapNotNull { (it as? JsonPrimitive)?.content }
    is JsonPrimitive -> listOf(aud.content)
    else -> emptyList()
  }
  val expires = (claims["exp"] as? JsonPrimitive)?.longOrNull
  val issued = (claims["iat"] as? JsonPrimitive)?.longOrNull
  val subject = claims.string("sub")
  if (claims.string("iss") != ISSUER || clientId !in audience ||
    (claims["azp"] != null && claims.string("azp") != clientId) ||
    expires == null || expires + CLOCK_TOLERANCE_SECONDS < seconds ||
    issued == null || issued - CLOCK_TOLERANCE_SECONDS > seconds ||
    subject.isNullOrEmpty() || (nonce != null && claims.string("nonce") != nonce)
  ) {
    invalid()
  }
  return Identity(subject, claims.string("email"))
}

private fun decodeObject(part: String) = Json.parseToJsonElement(base64Url.decode(part).decodeToString()) as JsonObject
