package io.github.tyanochkuby.androidagent

import com.facebook.react.ReactActivity
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {
  private var resumed = false

  override fun onResume() {
    super.onResume()
    resumed = true
    updateForegroundSession(hasWindowFocus())
  }

  override fun onPause() {
    resumed = false
    updateForegroundSession(false)
    super.onPause()
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    updateForegroundSession(hasFocus)
  }

  private fun updateForegroundSession(hasFocus: Boolean) {
    if (resumed && hasFocus) {
      if (foregroundSession?.activity !== this) {
        foregroundSession = ForegroundSession(this, ++nextSessionId)
      }
    } else if (foregroundSession?.activity === this) {
      foregroundSession = null
    }
  }

  internal class ForegroundSession(val activity: MainActivity, val id: Long)

  internal companion object {
    private var nextSessionId = 0L
    var foregroundSession: ForegroundSession? = null
      private set
  }

  override fun getMainComponentName() = "AndroidAgent"

  override fun createReactActivityDelegate() =
    DefaultReactActivityDelegate(this, mainComponentName)
}
