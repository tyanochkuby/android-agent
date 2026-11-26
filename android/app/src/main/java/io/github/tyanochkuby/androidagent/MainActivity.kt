package io.github.tyanochkuby.androidagent

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {
  private var resumed = false

  // Voice turns that outlive the assistant overlay report their result in a notification.
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    if (Build.VERSION.SDK_INT >= 33 &&
      checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) {
      requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 0)
    }
  }

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
