package io.github.tyanochkuby.androidagent

import android.content.Intent
import android.provider.Settings
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import io.github.tyanochkuby.androidagent.tasks.TaskRequest
import io.github.tyanochkuby.androidagent.tasks.taskJson
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class TaskModule(context: ReactApplicationContext) : NativeTasksSpec(context) {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  private val executor = (context.applicationContext as MainApplication).taskExecutor

  override fun getName() = NAME

  override fun submit(request: String, promise: Promise) = respond(promise) {
    require(request.length <= 65_536) { "Task request is too large." }
    val parsed = taskJson.decodeFromString<TaskRequest>(request)
    parsed.validate()
    taskJson.encodeToString(executor.submit(parsed))
  }

  override fun read(id: String?, promise: Promise) = respond(promise) {
    executor.read(id)?.let { taskJson.encodeToString(it) }
  }

  override fun resume(id: String, promise: Promise) = respond(promise) {
    taskJson.encodeToString(executor.resume(id))
  }

  override fun cancel(id: String, promise: Promise) = respond(promise) {
    taskJson.encodeToString(executor.cancel(id))
  }

  override fun openAccessibilitySettings(promise: Promise) = respond(promise) {
    val activity = checkNotNull(MainActivity.foregroundSession?.activity) { "Open Android Agent first." }
    activity.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
    null
  }

  override fun invalidate() {
    scope.cancel()
    super.invalidate()
  }

  private fun respond(promise: Promise, operation: suspend () -> String?) {
    scope.launch {
      try {
        promise.resolve(operation())
      } catch (error: CancellationException) {
        throw error
      } catch (error: Exception) {
        promise.reject("E_TASK", error)
      }
    }
  }

  companion object {
    const val NAME = "NativeTasks"
  }
}
