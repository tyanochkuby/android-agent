package io.github.tyanochkuby.androidagent.tasks

import android.app.KeyguardManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.os.PowerManager
import android.os.SystemClock
import android.provider.AlarmClock
import io.github.tyanochkuby.androidagent.MainActivity
import kotlinx.coroutines.delay

internal class AndroidActions(private val context: Context) {
  val foregroundSession get() = MainActivity.foregroundSession
    ?.takeIf { !it.activity.isFinishing && !it.activity.isDestroyed && screenAvailable }

  private val screenAvailable get() =
    context.getSystemService(PowerManager::class.java).isInteractive &&
      !context.getSystemService(KeyguardManager::class.java).isKeyguardLocked

  suspend fun execute(task: Task, step: Step, session: Long?): StepState =
    try {
      when (val action = step.action) {
        is Action.Search -> StepState(
          Phase.SUCCEEDED,
          Result.Matches(AppTarget.entries.filter {
            it.label.contains(action.query.trim(), ignoreCase = true) && launchIntent(it) != null
          }),
        )
        is Action.Observe -> {
          val observation = observe(task.resolve(action.target))
          if (observation == null) StepState(Phase.FAILED, detail = "No active app window was available.")
          else StepState(Phase.SUCCEEDED, observation)
        }
        is Action.StartTimer -> {
          val intent = Intent(AlarmClock.ACTION_SET_TIMER)
            .putExtra(AlarmClock.EXTRA_LENGTH, action.seconds)
            .putExtra(AlarmClock.EXTRA_SKIP_UI, true)
          val activity = confirmedActivity(session)
          if (activity == null) foregroundPause
          else {
            activity.startActivity(intent)
            StepState(Phase.ISSUED, detail = "Sent a timer request to Clock. Check Clock for the countdown.")
          }
        }
        is Action.Open -> {
          val app = task.resolve(action.target)
          val intent = launchIntent(app) ?: throw ActivityNotFoundException()
          val activity = confirmedActivity(session)
          if (activity == null) foregroundPause
          else {
            activity.startActivity(intent)
            verifyOpen(app)
          }
        }
      }
    } catch (error: ActivityNotFoundException) {
      StepState(Phase.FAILED, detail = "No installed app handles this action.")
    } catch (error: SecurityException) {
      StepState(Phase.FAILED, detail = "Android denied this action.")
    } catch (error: IllegalArgumentException) {
      StepState(Phase.FAILED, detail = error.message)
    }

  fun recover(task: Task, step: Step): StepState {
    return when (val action = step.action) {
      is Action.Search, is Action.Observe ->
        StepState(Phase.PAUSED, detail = "The app stopped. Confirm to repeat this read.")
      is Action.Open -> {
        val evidence = runCatching { observe(task.resolve(action.target)) }.getOrNull()
        if (evidence?.active == true) {
          StepState(Phase.SUCCEEDED, evidence, "The target window was observed during recovery.")
        } else {
          interruptedAction
        }
      }
      is Action.StartTimer -> interruptedAction
    }
  }

  private fun confirmedActivity(session: Long?) =
    foregroundSession?.takeIf { it.id == session }?.activity

  private fun launchIntent(app: AppTarget) =
    context.packageManager.getLaunchIntentForPackage(app.packageName)

  private fun observe(app: AppTarget): Result.Window? {
    if (!screenAvailable) return null
    val activePackage = try {
      WindowObserver.connected?.activePackage()
    } catch (error: SecurityException) {
      null
    } ?: return null
    return Result.Window(app, activePackage == app.packageName, System.currentTimeMillis())
  }

  private suspend fun verifyOpen(app: AppTarget): StepState {
    val deadline = SystemClock.elapsedRealtime() + 2_500
    while (screenAvailable && WindowObserver.connected != null) {
      val evidence = observe(app)
      if (evidence?.active == true) return StepState(Phase.SUCCEEDED, evidence)
      if (SystemClock.elapsedRealtime() >= deadline) break
      delay(100)
    }
    return StepState(Phase.ISSUED, detail = "App launch requested. The target window was not verified.")
  }

  private val AppTarget.label get() = when (this) {
    AppTarget.CALCULATOR -> "Calculator"
    AppTarget.MAPS -> "Google Maps"
  }

  private val AppTarget.packageName get() = when (this) {
    AppTarget.CALCULATOR -> "com.google.android.calculator"
    AppTarget.MAPS -> "com.google.android.apps.maps"
  }
}

internal val foregroundPause =
  StepState(Phase.PAUSED, detail = "Return to Android Agent and confirm to continue.")

internal val interruptedAction =
  StepState(Phase.UNKNOWN, detail = "The action may have run. Check its outcome before starting it again.")
