package io.github.tyanochkuby.androidagent

import android.content.ActivityNotFoundException
import android.content.Intent
import android.provider.AlarmClock
import com.facebook.react.common.LifecycleState
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.UiThreadUtil

class TimerModule(private val context: ReactApplicationContext) : NativeTimerSpec(context) {
  override fun getName() = NAME

  override fun requestTimer(durationSeconds: Double, promise: Promise) {
    if (durationSeconds !in 1.0..86_400.0 || durationSeconds % 1.0 != 0.0) {
      promise.reject("E_INVALID_DURATION", "Use a whole number of seconds from 1 to 86400.")
      return
    }

    UiThreadUtil.runOnUiThread {
      val activity = context.currentActivity
      if (
        context.lifecycleState != LifecycleState.RESUMED ||
        activity == null ||
        activity.isFinishing ||
        activity.isDestroyed
      ) {
        promise.reject("E_FOREGROUND_REQUIRED", "Open Android Agent to start a timer.")
        return@runOnUiThread
      }

      val intent = Intent(AlarmClock.ACTION_SET_TIMER)
        .putExtra(AlarmClock.EXTRA_LENGTH, durationSeconds.toInt())
        .putExtra(AlarmClock.EXTRA_SKIP_UI, true)

      try {
        activity.startActivity(intent)
        promise.resolve(null)
      } catch (error: ActivityNotFoundException) {
        promise.reject("E_NO_CLOCK", "Install or enable a clock app that supports Android timers.", error)
      } catch (error: SecurityException) {
        promise.reject("E_TIMER_ACCESS", "Android denied access to the clock app.", error)
      }
    }
  }

  companion object {
    const val NAME = "NativeTimer"
  }
}
