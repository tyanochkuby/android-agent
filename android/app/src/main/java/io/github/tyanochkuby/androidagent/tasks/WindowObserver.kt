package io.github.tyanochkuby.androidagent.tasks

import android.accessibilityservice.AccessibilityService
import android.os.Build
import android.view.accessibility.AccessibilityEvent
import io.github.tyanochkuby.androidagent.MainApplication

class WindowObserver : AccessibilityService() {
  override fun onServiceConnected() {
    connected = this
    (application as MainApplication).taskExecutor.reconcile()
  }

  override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit

  override fun onInterrupt() = Unit

  override fun onDestroy() {
    if (connected === this) connected = null
    super.onDestroy()
  }

  @Suppress("DEPRECATION")
  internal fun activePackage(): String? {
    val root = rootInActiveWindow ?: return null
    return try {
      root.packageName?.toString()
    } finally {
      if (Build.VERSION.SDK_INT < 33) root.recycle()
    }
  }

  internal companion object {
    var connected: WindowObserver? = null
      private set
  }
}
