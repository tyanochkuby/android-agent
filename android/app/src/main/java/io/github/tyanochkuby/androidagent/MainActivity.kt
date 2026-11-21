package io.github.tyanochkuby.androidagent

import com.facebook.react.ReactActivity
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {
  override fun getMainComponentName() = "AndroidAgent"

  override fun createReactActivityDelegate() =
    DefaultReactActivityDelegate(this, mainComponentName)
}
