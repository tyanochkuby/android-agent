package io.github.tyanochkuby.androidagent.assistant

import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.hardware.display.DisplayManager
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.service.voice.VoiceInteractionService
import android.service.voice.VoiceInteractionSession
import android.service.voice.VoiceInteractionSessionService
import android.speech.RecognitionService
import android.speech.SpeechRecognizer
import android.view.Display
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.view.WindowManager.LayoutParams
import io.github.tyanochkuby.androidagent.R
import kotlin.math.roundToInt

/** Makes Android Agent eligible for the default digital assistant role. */
class AssistantService : VoiceInteractionService() {
  private var overlay: View? = null

  override fun onReady() {
    super.onReady()
    setDisabledShowContext(
      VoiceInteractionSession.SHOW_WITH_ASSIST or VoiceInteractionSession.SHOW_WITH_SCREENSHOT,
    )
  }

  override fun onPrepareToShowSession(args: Bundle, flags: Int) {
    super.onPrepareToShowSession(args, flags)
    if (overlay != null) return
    if (!Settings.canDrawOverlays(this)) {
      startActivity(Intent(
        Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
        Uri.fromParts("package", packageName, null),
      ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      return
    }

    val display = getSystemService(DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY) ?: return
    val windowContext = createWindowContext(display, LayoutParams.TYPE_APPLICATION_OVERLAY, null)
    val manager = windowContext.getSystemService(WindowManager::class.java)
    val density = windowContext.resources.displayMetrics.density
    val size = (24 * density).roundToInt()
    val margin = (16 * density).roundToInt()
    val dot = View(windowContext).apply {
      background = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(Color.rgb(0x8A, 0xE2, 0x34))
      }
      contentDescription = getString(R.string.dismiss_assistant_dot)
      setOnClickListener { dismissDot() }
    }
    val layout = LayoutParams(
      size, size, LayoutParams.TYPE_APPLICATION_OVERLAY,
      LayoutParams.FLAG_NOT_FOCUSABLE or LayoutParams.FLAG_NOT_TOUCH_MODAL,
      PixelFormat.TRANSLUCENT,
    ).apply {
      gravity = Gravity.BOTTOM or Gravity.RIGHT
      x = margin
      y = margin
    }
    try {
      manager.addView(dot, layout)
      overlay = dot
    } catch (_: WindowManager.BadTokenException) {
      // Android can revoke overlay permission between the check and addView.
    }
  }

  private fun dismissDot() {
    val dot = overlay ?: return
    overlay = null
    dot.context.getSystemService(WindowManager::class.java).removeViewImmediate(dot)
  }

  override fun onShutdown() {
    dismissDot()
    super.onShutdown()
  }

  override fun onDestroy() {
    dismissDot()
    super.onDestroy()
  }
}

/** Android requires a recognizer before granting the assistant role. It declines every request until speech is designed. */
class AssistantRecognizer : RecognitionService() {
  override fun onStartListening(intent: Intent?, listener: Callback) = listener.error(SpeechRecognizer.ERROR_RECOGNIZER_BUSY)
  override fun onStopListening(listener: Callback) = Unit
  override fun onCancel(listener: Callback) = Unit
}

/** Android binds this whenever the user invokes the assistant. */
class AssistantSessionService : VoiceInteractionSessionService() {
  override fun onNewSession(args: Bundle?) = object : VoiceInteractionSession(this) {
    override fun onCreate() {
      super.onCreate()
      setUiEnabled(false)
    }
  }
}
