package io.github.tyanochkuby.androidagent.tasks

import android.content.Context
import android.os.SystemClock
import java.util.UUID

/**
 * Whether the user turned on screen sharing in Android Agent. It stays on across prompts, typed or spoken, until the
 * user turns it off. Off is the default.
 */
internal object ScreenConsent {
  fun enabled(context: Context) = preferences(context).getBoolean(KEY, false)

  fun set(context: Context, enabled: Boolean) {
    check(preferences(context).edit().putBoolean(KEY, enabled).commit()) { "Could not save the setting." }
  }

  private fun preferences(context: Context) = context.getSharedPreferences("settings", Context.MODE_PRIVATE)

  const val OFF = "Screen sharing is off. Turn on Share screen with the agent in Android Agent first."
  private const val KEY = "screenSharing"
}

/**
 * Screen access for one voice request, starting from the app [source] that was in front when the user finished
 * speaking. Granted only while [ScreenConsent] is on. A grant lets that request read [source] and open other apps until
 * it is revoked or expires. Use on the main thread.
 */
internal object ScreenGrants {
  data class Grant(val id: String, val source: String, val expiresAt: Long)

  private val grants = java.util.concurrent.ConcurrentHashMap<String, Grant>()

  fun grant(source: String) = Grant(UUID.randomUUID().toString(), source, SystemClock.elapsedRealtime() + LIFETIME_MS)
    .also { grants[it.id] = it }

  fun active(id: String) = grants[id]?.takeIf { SystemClock.elapsedRealtime() < it.expiresAt }

  fun revoke(id: String) {
    grants.remove(id)
  }

  fun clear() = grants.clear()

  /** Matches the voice turn timeout, so a grant never outlives its request. */
  const val LIFETIME_MS = 180_000L
}
