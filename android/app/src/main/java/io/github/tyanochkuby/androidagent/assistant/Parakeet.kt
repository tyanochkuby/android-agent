package io.github.tyanochkuby.androidagent.assistant

import android.content.res.AssetManager
import com.k2fsa.sherpa.onnx.OfflineModelConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig
import com.k2fsa.sherpa.onnx.OfflineTransducerModelConfig
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** Keeps model initialization, decoding and eviction on the same worker. */
internal class Transcriber(private val assets: AssetManager) {
  private val worker = ScheduledThreadPoolExecutor(1).apply {
    removeOnCancelPolicy = true
    executeExistingDelayedTasksAfterShutdownPolicy = false
  }
  @Volatile private var recognizer: OfflineRecognizer? = null
  private var eviction: java.util.concurrent.ScheduledFuture<*>? = null
  val loaded get() = recognizer != null

  fun prepare() = worker.execute {
    runCatching { load() }
    scheduleEviction()
  }

  fun transcribe(samples: FloatArray, isCancelled: () -> Boolean = { false }, onResult: (String?) -> Unit) {
    worker.execute {
      if (isCancelled()) return@execute
      val result = runCatching {
        val model = load()
        if (isCancelled()) return@runCatching null
        val stream = model.createStream()
        try {
          stream.acceptWaveform(samples, SAMPLE_RATE)
          model.decode(stream)
          model.getResult(stream).text.trim()
        } finally {
          stream.release()
        }
      }.getOrNull()
      scheduleEviction()
      if (!isCancelled()) onResult(result)
    }
  }

  fun evict() = worker.execute { release() }

  fun close() {
    worker.execute { release() }
    worker.shutdown()
  }

  private fun scheduleEviction() {
    eviction?.cancel(false)
    if (!worker.isShutdown) eviction = worker.schedule({ release() }, 10, TimeUnit.MINUTES)
  }

  private fun release() {
    eviction?.cancel(false)
    recognizer?.release()
    recognizer = null
  }

  private fun load() = recognizer ?: OfflineRecognizer(
    assets,
    OfflineRecognizerConfig(
      modelConfig = OfflineModelConfig(
        transducer = OfflineTransducerModelConfig(
          encoder = "$MODEL/encoder.int8.onnx",
          decoder = "$MODEL/decoder.int8.onnx",
          joiner = "$MODEL/joiner.int8.onnx",
        ),
        tokens = "$MODEL/tokens.txt",
        modelType = "nemo_transducer",
        numThreads = 4,
      ),
    ),
  ).also { recognizer = it }

  companion object {
    const val SAMPLE_RATE = 16_000
    private const val MODEL = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8"
  }
}
