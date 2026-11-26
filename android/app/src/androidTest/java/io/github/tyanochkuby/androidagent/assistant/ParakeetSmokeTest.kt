package io.github.tyanochkuby.androidagent.assistant

import android.os.SystemClock
import android.util.Log
import androidx.test.platform.app.InstrumentationRegistry
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.CountDownLatch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Decodes every `<language>-<name>.wav` test asset with the installed model, twice, so the log shows cold and warm decode times.
 * Generate the assets with scripts/speech-samples.sh. Read results with `adb logcat -s ParakeetSmoke`.
 * Asserts a nonempty transcript; word error rate against the optional `.txt` is logged for comparison, not asserted.
 */
class ParakeetSmokeTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val samples = instrumentation.context.assets

  @Test
  fun transcribesSamples() {
    val names = samples.list("")!!.filter { it.endsWith(".wav") }.sorted()
    assertTrue("No samples. Run android/scripts/speech-samples.sh first.", names.isNotEmpty())
    val model = SpeechModel(instrumentation.targetContext)
    runBlocking { model.install() }
    val transcriber = Transcriber(model.directory)
    try {
      for (round in 1..2) for (name in names) {
        val audio = readWav(name)
        val cold = !transcriber.loaded
        val start = SystemClock.elapsedRealtime()
        val transcript = transcribe(transcriber, audio)
        val decodeMs = SystemClock.elapsedRealtime() - start
        val expected = runCatching { samples.open(name.replace(".wav", ".txt")).reader().readText() }.getOrNull()
        val wer = expected?.let { "%.2f".format(wordErrorRate(it, transcript)) }
        Log.i(TAG, "round=$round $name cold=$cold audioMs=${audio.size * 1000 / Transcriber.SAMPLE_RATE} decodeMs=$decodeMs wer=$wer")
        assertTrue(name, transcript.isNotBlank())
      }
    } finally {
      transcriber.close()
    }
  }

  private fun transcribe(transcriber: Transcriber, audio: FloatArray): String {
    var result: String? = null
    val done = CountDownLatch(1)
    transcriber.transcribe(audio) { result = it; done.countDown() }
    check(done.await(90, java.util.concurrent.TimeUnit.SECONDS)) { "Timed out waiting for transcription" }
    return checkNotNull(result) { "Decoding failed" }
  }

  /** Reads a canonical 44-byte-header 16 kHz mono 16-bit WAV. */
  private fun readWav(name: String): FloatArray {
    val bytes = samples.open(name).readBytes()
    val pcm = ByteBuffer.wrap(bytes, 44, bytes.size - 44).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
    return FloatArray(pcm.remaining()) { pcm.get(it) / 32768f }
  }

  private fun wordErrorRate(expected: String, actual: String): Double {
    fun words(text: String) = text.lowercase().split(Regex("[^\\p{L}\\p{N}]+")).filter { it.isNotEmpty() }
    val a = words(expected)
    val b = words(actual)
    var previous = IntArray(b.size + 1) { it }
    for (i in a.indices) {
      val current = IntArray(b.size + 1).also { it[0] = i + 1 }
      for (j in b.indices) current[j + 1] = minOf(previous[j + 1] + 1, current[j] + 1, previous[j] + if (a[i] == b[j]) 0 else 1)
      previous = current
    }
    return previous[b.size].toDouble() / a.size.coerceAtLeast(1)
  }

  private companion object {
    const val TAG = "ParakeetSmoke"
  }
}
