package io.github.tyanochkuby.androidagent.tasks

import android.accessibilityservice.AccessibilityService
import android.view.accessibility.AccessibilityEvent
import io.github.tyanochkuby.androidagent.MainApplication

class WindowObserver : AccessibilityService() {
  override fun onServiceConnected() {
    connected = this
    (application as MainApplication).taskExecutor.reconcile()
  }

  internal var session: UiSession? = null

  override fun onAccessibilityEvent(event: AccessibilityEvent?) {
    when (event?.eventType) {
      AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> session?.foregroundChanged(activePackage())
      AccessibilityEvent.TYPE_TOUCH_INTERACTION_START -> session?.stop()
    }
  }

  override fun onInterrupt() { session?.stop() }

  override fun onDestroy() {
    session?.stop()
    if (connected === this) connected = null
    super.onDestroy()
  }

  internal fun activePackage(): String? {
    val root = rootInActiveWindow ?: return null
    return useNode(root) { root.packageName?.toString() }
  }

  internal companion object {
    var connected: WindowObserver? = null
      private set
  }
}
