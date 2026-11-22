package io.github.tyanochkuby.androidagent

import com.facebook.react.ReactActivity
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {
  override fun onResume() {
    super.onResume()
    foregroundSession = ForegroundSession(this, ++nextSessionId)
  }

  override fun onPause() {
    if (foregroundSession?.activity === this) foregroundSession = null
    super.onPause()
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
