package io.github.tyanochkuby.androidagent.assistant

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Hands a final transcript to the shared React Native runtime as the `VoiceTurn` headless task, starting the runtime
 * without an Activity when needed. Pending turns live only in memory, so a turn lost with the process is never replayed.
 * Call [start] and [finish] on the main thread.
 */
internal object VoiceTurns {
  private val main = Handler(Looper.getMainLooper())
  private data class Pending(
    val result: (String, Boolean) -> Unit,
    val timeout: Runnable,
    var runtime: ReactContext? = null,
  )
  private val pending = mutableMapOf<String, Pending>()

  /** Starts one turn. [onResult] receives the reply, or the failure text with `failed = true`. */
  fun start(context: Context, transcript: String, onResult: (text: String, failed: Boolean) -> Unit) {
    UiThreadUtil.assertOnUiThread()
    val id = UUID.randomUUID().toString()
    val timeout = Runnable { finish(id, "Android Agent did not return a reply in time.", true) }
    pending[id] = Pending(onResult, timeout)
    main.postDelayed(timeout, 180_000)
    val data = Arguments.createMap().apply {
      putString("id", id)
      putString("transcript", transcript)
    }
    // Allowed in the foreground because Android Agent's own screen may be open; the JS side reports it busy.
    val task = HeadlessJsTaskConfig("VoiceTurn", data, isAllowedInForeground = true)
    val host = checkNotNull((context.applicationContext as ReactApplication).reactHost)
    val startup = host.start()
    thread(name = "VoiceTurnStartup") {
      val ready = runCatching {
        startup.waitForCompletion(30, TimeUnit.SECONDS) &&
          !startup.isCancelled() && !startup.isFaulted()
      }.getOrDefault(false)
      UiThreadUtil.runOnUiThread {
        val reactContext = if (ready) host.currentReactContext?.takeIf { it.hasActiveReactInstance() } else null
        if (reactContext == null) finish(id, "Android Agent could not start. Try again.", true)
        else run(id, reactContext, task)
      }
    }
  }

  private fun run(id: String, context: ReactContext, task: HeadlessJsTaskConfig) {
    val turn = pending[id] ?: return
    turn.runtime = context
    try {
      HeadlessJsTaskContext.getInstance(context).startTask(task)
    } catch (_: RuntimeException) {
      finish(id, "Android Agent could not start this voice turn.", true)
    }
  }

  fun invalidate(context: ReactContext) = UiThreadUtil.runOnUiThread {
    pending.filterValues { it.runtime === context }.keys.toList().forEach { id ->
      finish(id, "Android Agent restarted before replying.", true)
    }
  }

  /** Called by the runtime once per turn. Unknown IDs, such as turns started before a process restart, are ignored. */
  fun finish(id: String, text: String, failed: Boolean) {
    val turn = pending.remove(id) ?: return
    main.removeCallbacks(turn.timeout)
    turn.result(text, failed)
  }
}
