package io.github.tyanochkuby.androidagent.assistant

import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Energy-based endpointing for one utterance. Feed the RMS of each consecutive [FRAME_MS] frame to [accept] until it returns an [Endpoint].
 * The noise floor follows the quietest recent frames, so steady background noise does not count as speech.
 */
class Endpointer(
  private val silenceFrames: Int = 700 / FRAME_MS,
  private val noSpeechFrames: Int = 5_000 / FRAME_MS,
  private val maxFrames: Int = 15_000 / FRAME_MS,
) {
  /** Index of the last frame counted as speech, or -1 before speech starts. */
  var lastVoicedFrame = -1
    private set

  private var frames = 0
  private var initialLevel = 0f
  private var checkingInitialSpeech = true
  private var voicedRun = 0
  private var floor = Float.MAX_VALUE
  private val speaking get() = lastVoicedFrame >= 0

  fun accept(rms: Float): Endpoint? {
    val frame = frames++
    if (frame == 0) initialLevel = rms
    if (checkingInitialSpeech && (speaking || rms < initialLevel / SPEECH_OVER_FLOOR)) {
      checkingInitialSpeech = false
      // A sustained opening burst can only be distinguished from steady noise once it gets quieter.
      if (!speaking && frame >= START_FRAMES && initialLevel > MIN_SPEECH_RMS * SPEECH_OVER_FLOOR) {
        lastVoicedFrame = frame - 1
      }
    }
    floor = min(rms, if (floor == Float.MAX_VALUE) rms else floor * FLOOR_RISE)
    voicedRun = if (rms > max(floor * SPEECH_OVER_FLOOR, MIN_SPEECH_RMS)) voicedRun + 1 else 0
    if (voicedRun >= START_FRAMES || speaking && voicedRun > 0) lastVoicedFrame = frame
    return when {
      frames >= maxFrames -> if (speaking) Endpoint.TOO_LONG else Endpoint.NO_SPEECH
      speaking && frame - lastVoicedFrame >= silenceFrames -> Endpoint.SPEECH_ENDED
      !speaking && frames >= noSpeechFrames -> Endpoint.NO_SPEECH
      else -> null
    }
  }

  companion object {
    const val FRAME_MS = 20
    private const val START_FRAMES = 3
    private const val SPEECH_OVER_FLOOR = 3f
    private const val MIN_SPEECH_RMS = 0.003f
    /** Lets the floor climb about 65% per second when the room gets louder. */
    private const val FLOOR_RISE = 1.01f

    fun rms(samples: FloatArray, from: Int, to: Int): Float {
      var sum = 0.0
      for (i in from until to) sum += samples[i] * samples[i]
      return if (to <= from) 0f else sqrt(sum / (to - from)).toFloat()
    }
  }
}

enum class Endpoint { SPEECH_ENDED, TOO_LONG, NO_SPEECH }
