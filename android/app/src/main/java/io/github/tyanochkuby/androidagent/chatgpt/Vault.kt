package io.github.tyanochkuby.androidagent.chatgpt

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

@Serializable
data class Session(
  val accessToken: String,
  val refreshToken: String,
  val expiresAt: Long,
  val earliestRefreshAt: Long? = null,
  val scopes: List<String>,
)

/**
 * The app's registration with ChatGPT and the account bound to it. The subject and client ID
 * survive sign-out, so a later sign-in must return the same account.
 */
@Serializable
data class Account(
  val hostId: String = "urn:uuid:${UUID.randomUUID()}",
  val clientId: String? = null,
  val subject: String? = null,
  val email: String? = null,
  val model: String? = null,
  val contextWindow: Int? = null,
  val planUsageDeclined: Boolean = false,
  val reauthRequired: Boolean = false,
  val session: Session? = null,
)

/** Keeps the account in app preferences, encrypted with an AES-GCM key held by Android Keystore. */
class Vault(context: Context) {
  private val preferences = context.getSharedPreferences("chatgpt", Context.MODE_PRIVATE)
  private val json = Json { ignoreUnknownKeys = true }

  suspend fun read(): Account = withContext(Dispatchers.IO) {
    val saved = preferences.getString(ACCOUNT, null) ?: return@withContext Account()
    // A key lost with a restore or a lock-screen reset leaves nothing to resume.
    runCatching {
      val bytes = base64Url.decode(saved)
      val cipher = Cipher.getInstance(TRANSFORMATION)
      cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, IV_BYTES))
      json.decodeFromString<Account>(cipher.doFinal(bytes, IV_BYTES, bytes.size - IV_BYTES).decodeToString())
    }.getOrElse { Account() }
  }

  suspend fun write(account: Account) = withContext(Dispatchers.IO) {
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, key())
    val sealed = cipher.iv + cipher.doFinal(json.encodeToString(account).toByteArray())
    check(preferences.edit().putString(ACCOUNT, base64Url.encode(sealed)).commit()) { "Could not save the ChatGPT sign-in." }
  }

  private fun key(): SecretKey {
    val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE).run {
      init(
        KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
          .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
          .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
          .setKeySize(256)
          .build(),
      )
      generateKey()
    }
  }

  private companion object {
    const val ACCOUNT = "account"
    const val ALIAS = "chatgpt-account"
    const val KEYSTORE = "AndroidKeyStore"
    const val TRANSFORMATION = "AES/GCM/NoPadding"
    const val IV_BYTES = 12
  }
}
