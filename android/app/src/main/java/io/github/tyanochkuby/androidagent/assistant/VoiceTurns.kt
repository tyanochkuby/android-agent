package io.github.tyanochkuby.androidagent.assistant

import android.content.Context
import com.facebook.react.ReactApplication
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import java.util.UUID

/**
 * Hands a final transcript to the shared React Native runtime as the `VoiceTurn` headless task, starting the runtime
 * without an Activity when needed. Pending turns live only in memory, so a turn lost with the process is never replayed.
 * Call [start] and [finish] on the main thread.
 */
internal object VoiceTurns {
  private val pending = mutableMapOf<String, (String, Boolean) -> Unit>()

  /** Starts one turn. [onResult] receives the reply, or the failure text with `failed = true`. */
  fun start(context: Context, transcript: String, onResult: (text: String, failed: Boolean) -> Unit) {
    UiThreadUtil.assertOnUiThread()
    val id = UUID.randomUUID().toString()
    pending[id] = onResult
    val data = Arguments.createMap().apply {
      putString("id", id)
      putString("transcript", transcript)
    }
    // Allowed in the foreground because Android Agent's own screen may be open; the JS side reports it busy.
    val task = HeadlessJsTaskConfig("VoiceTurn", data, isAllowedInForeground = true)
    val host = checkNotNull((context.applicationContext as ReactApplication).reactHost)
    val running = host.currentReactContext
    if (running != null) return run(running, task)
    host.addReactInstanceEventListener(object : ReactInstanceEventListener {
      override fun onReactContextInitialized(context: ReactContext) {
        host.removeReactInstanceEventListener(this)
        UiThreadUtil.runOnUiThread { run(context, task) }
      }
    })
    host.start()
  }

  private fun run(context: ReactContext, task: HeadlessJsTaskConfig) {
    HeadlessJsTaskContext.getInstance(context).startTask(task)
  }

  /** Called by the runtime once per turn. Unknown IDs, such as turns started before a process restart, are ignored. */
  fun finish(id: String, text: String, failed: Boolean) {
    pending.remove(id)?.invoke(text, failed)
  }
}
