package io.github.tyanochkuby.androidagent.assistant

import android.graphics.Color
import android.graphics.Region
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionService
import android.speech.SpeechRecognizer
import android.service.voice.VoiceInteractionService
import android.service.voice.VoiceInteractionSession
import android.service.voice.VoiceInteractionSessionService
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.view.WindowManager.LayoutParams
import android.widget.FrameLayout

/** Makes Android Agent eligible for the default digital assistant role. */
class AssistantService : VoiceInteractionService() {
  override fun onReady() {
    super.onReady()
    setDisabledShowContext(
      VoiceInteractionSession.SHOW_WITH_ASSIST or VoiceInteractionSession.SHOW_WITH_SCREENSHOT,
    )
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
  override fun onNewSession(args: Bundle?) = AssistantSession(this)
}

/** Shows a passive dot in the bottom-right corner while the foreground app keeps touch, focus and the keyboard. */
class AssistantSession(service: VoiceInteractionSessionService) : VoiceInteractionSession(service) {
  override fun onCreate() {
    super.onCreate()
    val window = window.window ?: return
    window.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
    window.clearFlags(LayoutParams.FLAG_DIM_BEHIND or LayoutParams.FLAG_LAYOUT_IN_SCREEN or LayoutParams.FLAG_LAYOUT_INSET_DECOR)
    window.addFlags(LayoutParams.FLAG_NOT_FOCUSABLE or LayoutParams.FLAG_NOT_TOUCHABLE or LayoutParams.FLAG_NOT_TOUCH_MODAL)
    window.setLayout(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT)
    window.setGravity(Gravity.BOTTOM or Gravity.RIGHT)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      window.attributes = window.attributes.apply { fitInsetsTypes = WindowInsets.Type.systemBars() or WindowInsets.Type.ime() }
    }
  }

  override fun onCreateContentView(): View {
    val density = context.resources.displayMetrics.density
    val size = (16 * density).toInt()
    val margin = (16 * density).toInt()
    val dot = View(context).apply {
      background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.rgb(0x8A, 0xE2, 0x34)) }
      contentDescription = "Android Agent assistant session"
    }
    return FrameLayout(context).apply {
      addView(dot, FrameLayout.LayoutParams(size, size).apply { setMargins(margin, margin, margin, margin) })
    }
  }

  override fun onComputeInsets(outInsets: Insets) {
    outInsets.contentInsets.setEmpty()
    outInsets.touchableRegion.set(Region())
    outInsets.touchableInsets = Insets.TOUCHABLE_INSETS_REGION
  }
}
