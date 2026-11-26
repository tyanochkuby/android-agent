package io.github.tyanochkuby.androidagent.assistant

import android.Manifest
import android.app.Activity
import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.ComponentCallbacks2
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.hardware.display.DisplayManager
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioRecordingConfiguration
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import android.service.voice.VoiceInteractionService
import android.service.voice.VoiceInteractionSession
import android.service.voice.VoiceInteractionSessionService
import android.speech.RecognitionService
import android.speech.SpeechRecognizer
import android.util.Log
import android.view.Display
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.view.WindowManager.LayoutParams
import android.widget.TextView
import io.github.tyanochkuby.androidagent.R
import kotlin.concurrent.thread
import kotlin.math.roundToInt

/** Makes Android Agent eligible for the default digital assistant role and owns the listening dot across session hides. */
class AssistantService : VoiceInteractionService() {
  private var overlay: View? = null
  private var listening: Utterance? = null
  private var preparedAt: Long? = null

  override fun onReady() {
    super.onReady()
    setDisabledShowContext(
      VoiceInteractionSession.SHOW_WITH_ASSIST or VoiceInteractionSession.SHOW_WITH_SCREENSHOT,
    )
    active = this
  }

  override fun onPrepareToShowSession(args: Bundle, flags: Int) {
    super.onPrepareToShowSession(args, flags)
    preparedAt = SystemClock.elapsedRealtime()
  }

  private fun onInvoked() {
    val invokedAt = preparedAt ?: SystemClock.elapsedRealtime()
    preparedAt = null
    if (listening != null) return finish(null)
    removeOverlay()
    val unlocked = !getSystemService(KeyguardManager::class.java).isKeyguardLocked
    if (!unlocked || !getSystemService(PowerManager::class.java).isInteractive) return
    if (!Settings.canDrawOverlays(this)) {
      startActivity(Intent(
        Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
        Uri.fromParts("package", packageName, null),
      ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      return
    }
    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      startActivity(Intent(this, MicrophonePermissionActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      return
    }
    listening = Utterance(invokedAt, cold = !transcriber.loaded)
  }

  private fun finish(card: String?) {
    listening?.release()
    listening = null
    removeOverlay()
    card?.let(::showCard)
  }

  /**
   * One offline utterance. The mic thread records until [Endpointer] ends it, then the transcriber decodes the audio.
   * Audio and transcripts stay in memory and on screen; logs carry only timings and error codes. Every terminal path calls [finish].
   */
  private inner class Utterance(private val invokedAt: Long, private val cold: Boolean) {
    private val main = Handler(Looper.getMainLooper())
    private val dot = showDot(Color.GRAY)
    private val screenOff = object : BroadcastReceiver() {
      override fun onReceive(context: Context, intent: Intent) = finish(null)
    }
    @Volatile private var cancelled = false
    @Volatile private var silenced = false
    private var readyAt: Long? = null
    private val mic: Thread

    init {
      registerReceiver(screenOff, IntentFilter(Intent.ACTION_SCREEN_OFF), Context.RECEIVER_NOT_EXPORTED)
      transcriber.prepare()
      mic = thread(name = "AssistantMic") { record() }
    }

    /** Stops recording or decoding. The mic thread releases the AudioRecord within one frame. */
    fun release() {
      cancelled = true
      unregisterReceiver(screenOff)
      mic.join(MIC_RELEASE_TIMEOUT_MS)
    }

    private fun record() {
      val record = try {
        val frameBytes = FRAME_SAMPLES * Float.SIZE_BYTES
        val buffer = maxOf(AudioRecord.getMinBufferSize(Transcriber.SAMPLE_RATE, CHANNEL, ENCODING), frameBytes * 10)
        AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, Transcriber.SAMPLE_RATE, CHANNEL, ENCODING, buffer)
      } catch (_: SecurityException) {
        return fail(SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS)
      }
      try {
        if (record.state != AudioRecord.STATE_INITIALIZED) return fail(SpeechRecognizer.ERROR_AUDIO)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          record.registerAudioRecordingCallback(Runnable::run, object : AudioManager.AudioRecordingCallback() {
            override fun onRecordingConfigChanged(configs: List<AudioRecordingConfiguration>) {
              silenced = silenced || configs.any { it.clientAudioSessionId == record.audioSessionId && it.isClientSilenced }
            }
          })
        }
        record.startRecording()
        if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) return fail(SpeechRecognizer.ERROR_AUDIO)

        val audio = FloatArray(MAX_SAMPLES)
        val endpointer = Endpointer()
        var recorded = 0
        var frame = 0
        var lastVoicedAt = 0L
        while (true) {
          val read = record.read(audio, recorded, FRAME_SAMPLES, AudioRecord.READ_BLOCKING)
          if (cancelled) return
          // Android silences a client when a higher-priority app takes the mic. Ticket 02 discards interrupted speech.
          if (silenced) return fail(SpeechRecognizer.ERROR_AUDIO, card = false)
          if (read <= 0) return fail(SpeechRecognizer.ERROR_AUDIO)
          val now = SystemClock.elapsedRealtime()
          if (recorded == 0) main.post { onReady(now) }
          val endpoint = endpointer.accept(Endpointer.rms(audio, recorded, recorded + read))
          recorded += read
          if (endpointer.lastVoicedFrame == frame++) lastVoicedAt = now
          if (endpoint == null) continue
          record.stop()
          val speech = audio.copyOf(minOf(recorded, (endpointer.lastVoicedFrame + 1) * FRAME_SAMPLES + TRAILING_SAMPLES))
          main.post { onEndpoint(endpoint, speech, lastVoicedAt, now) }
          return
        }
      } finally {
        record.release()
      }
    }

    private fun onReady(at: Long) {
      if (listening !== this) return
      readyAt = at
      (dot?.background as? GradientDrawable)?.setColor(LISTENING)
    }

    private fun onEndpoint(endpoint: Endpoint, speech: FloatArray, lastVoicedAt: Long, endpointAt: Long) {
      if (listening !== this) return
      if (endpoint == Endpoint.NO_SPEECH) {
        Log.i(TAG, "noSpeech cold=$cold invocationToReadyMs=${readyAt?.minus(invokedAt)}")
        return finish(null)
      }
      (dot?.background as? GradientDrawable)?.setColor(Color.GRAY)
      transcriber.transcribe(speech, { cancelled }) { transcript -> main.post { onTranscript(transcript, endpoint, speech.size, lastVoicedAt, endpointAt) } }
    }

    private fun onTranscript(transcript: String?, endpoint: Endpoint, samples: Int, lastVoicedAt: Long, endpointAt: Long) {
      if (listening !== this) return
      val now = SystemClock.elapsedRealtime()
      val timing = Timing(
        cold = cold,
        invocationToReady = readyAt?.minus(invokedAt) ?: -1,
        speechEndToFinal = now - lastVoicedAt,
        endpointWait = endpointAt - lastVoicedAt,
        decode = now - endpointAt,
        audio = samples * 1000L / Transcriber.SAMPLE_RATE,
      )
      Log.i(TAG, "result endpoint=$endpoint $timing")
      if (transcript == null) return fail(SpeechRecognizer.ERROR_CLIENT)
      if (transcript.isBlank()) return finish(null)
      finish(getString(R.string.assistant_transcript, transcript, timing.summary))
    }

    /** Callable from any thread. */
    private fun fail(error: Int, card: Boolean = true) {
      main.post {
        if (listening !== this) return@post
        Log.i(TAG, "error=$error cold=$cold invocationToReadyMs=${readyAt?.minus(invokedAt)}")
        finish(if (card) getString(R.string.assistant_recognizer_error, error) else null)
      }
    }
  }

  /** Tapping the dot cancels listening. */
  private fun showDot(color: Int): View? {
    val size = (24 * resources.displayMetrics.density).roundToInt()
    val dot = View(this).apply {
      background = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(color)
      }
      contentDescription = getString(R.string.dismiss_assistant_dot)
      setOnClickListener { finish(null) }
    }
    return addOverlay(dot, size, size)
  }

  /** Keeps the final transcript and timings on screen for manual comparison until tapped. */
  private fun showCard(text: String) {
    val density = resources.displayMetrics.density
    val padding = (12 * density).roundToInt()
    val card = TextView(this).apply {
      this.text = text
      setTextColor(Color.WHITE)
      maxWidth = (280 * density).roundToInt()
      setPadding(padding, padding, padding, padding)
      background = GradientDrawable().apply {
        cornerRadius = 12 * density
        setColor(Color.argb(0xE6, 0x20, 0x20, 0x20))
      }
      setOnClickListener { removeOverlay() }
    }
    addOverlay(card, LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT)
  }

  private fun addOverlay(view: View, width: Int, height: Int): View? {
    val margin = (16 * resources.displayMetrics.density).roundToInt()
    val layout = LayoutParams(
      width, height, LayoutParams.TYPE_APPLICATION_OVERLAY,
      LayoutParams.FLAG_NOT_FOCUSABLE or LayoutParams.FLAG_NOT_TOUCH_MODAL,
      PixelFormat.TRANSLUCENT,
    ).apply {
      gravity = Gravity.BOTTOM or Gravity.RIGHT
      x = margin
      y = margin
    }
    return try {
      windowManager.addView(view, layout)
      overlay = view
      view
    } catch (_: WindowManager.BadTokenException) {
      // Android can revoke overlay permission between the check and addView.
      null
    }
  }

  private fun removeOverlay() {
    val view = overlay ?: return
    overlay = null
    windowManager.removeViewImmediate(view)
  }

  private val windowManager by lazy {
    val display = getSystemService(DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY)
    createWindowContext(display, LayoutParams.TYPE_APPLICATION_OVERLAY, null).getSystemService(WindowManager::class.java)
  }

  /** Android calls this when the assistant role moves to another app. */
  override fun onShutdown() {
    active = null
    finish(null)
    closeTranscriber()
    super.onShutdown()
  }

  override fun onDestroy() {
    active = null
    finish(null)
    closeTranscriber()
    super.onDestroy()
  }

  override fun onTrimMemory(level: Int) {
    super.onTrimMemory(level)
    if (listening == null && (level >= ComponentCallbacks2.TRIM_MEMORY_BACKGROUND ||
        level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL)) {
      transcriberOrNull?.evict()
    }
  }

  override fun onLowMemory() {
    super.onLowMemory()
    if (listening == null) transcriberOrNull?.evict()
  }

  private var transcriberOrNull: Transcriber? = null
  private val transcriber get() = transcriberOrNull ?: Transcriber(assets).also { transcriberOrNull = it }

  private fun closeTranscriber() {
    transcriberOrNull?.close()
    transcriberOrNull = null
  }

  companion object {
    private const val TAG = "AssistantSpeech"
    private val LISTENING = Color.rgb(0x8A, 0xE2, 0x34)
    private const val CHANNEL = AudioFormat.CHANNEL_IN_MONO
    private const val ENCODING = AudioFormat.ENCODING_PCM_FLOAT
    private const val FRAME_SAMPLES = Transcriber.SAMPLE_RATE * Endpointer.FRAME_MS / 1000
    private const val MAX_SAMPLES = Transcriber.SAMPLE_RATE * 15
    private const val TRAILING_SAMPLES = Transcriber.SAMPLE_RATE / 5
    private const val MIC_RELEASE_TIMEOUT_MS = 200L
    private var active: AssistantService? = null

    /** Called by the session on every invocation. A second invocation while listening cancels the utterance. */
    fun invoked() = active?.onInvoked()
  }
}

/** Latencies of one utterance in milliseconds. Speech end is the last frame [Endpointer] counted as speech. */
private data class Timing(
  val cold: Boolean,
  val invocationToReady: Long,
  val speechEndToFinal: Long,
  val endpointWait: Long,
  val decode: Long,
  val audio: Long,
) {
  val summary get() =
    "${if (cold) "cold" else "warm"} · ready $invocationToReady ms · final $speechEndToFinal ms (endpoint $endpointWait + processing $decode) · audio $audio ms"
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

    override fun onShow(args: Bundle?, showFlags: Int) {
      super.onShow(args, showFlags)
      AssistantService.invoked()
    }
  }
}

/** Shows Android's microphone prompt once over the foreground app, then returns to it. */
class MicrophonePermissionActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 0)
  }

  override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, grantResults: IntArray) = finish()
}
