package io.github.tyanochkuby.androidagent.assistant

import android.content.Context
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.DigestInputStream
import java.security.MessageDigest
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.compressors.bzip2.BZip2CompressorInputStream

/** Publishes the pinned model only after verifying and extracting the complete archive. */
internal class SpeechModel(context: Context) {
  private val root = File(context.noBackupFilesDir, "speech")
  val directory = File(root, "$MODEL-${SHA256.take(12)}")
  val installed get() = files.all { File(directory, it).length() > 0 }

  suspend fun install() = withContext(Dispatchers.IO) {
    installLock.withLock {
      if (installed) return@withLock
      val staging = File(root, "installing")
      check(staging.deleteRecursively() && staging.mkdirs()) { "Could not prepare speech storage." }
      try {
        check(root.usableSpace >= REQUIRED_SPACE) { "Free at least 1.2 GB to install offline speech." }
        val archive = File(staging, "model.tar.bz2")
        download(archive)
        val extracted = File(staging, "model")
        check(extracted.mkdir())
        unpack(archive, extracted)
        coroutineContext.ensureActive()
        check(directory.deleteRecursively() && extracted.renameTo(directory)) { "Could not install offline speech." }
      } finally {
        staging.deleteRecursively()
      }
    }
  }

  private suspend fun download(archive: File) {
    val connection = (URL(URL_STRING).openConnection() as HttpURLConnection).apply {
      connectTimeout = 30_000
      readTimeout = 30_000
    }
    try {
      check(connection.responseCode == 200 && connection.url.protocol == "https") {
        "Could not download offline speech. Try again."
      }
      val digest = MessageDigest.getInstance("SHA-256")
      DigestInputStream(connection.inputStream, digest).use { input ->
        archive.outputStream().buffered().use { copy(input, it, DOWNLOAD_BYTES) }
      }
      check(archive.length() == DOWNLOAD_BYTES &&
        digest.digest().joinToString("") { "%02x".format(it) } == SHA256) {
        "The offline speech download failed verification. Try again."
      }
    } finally {
      connection.disconnect()
    }
  }

  private suspend fun unpack(archive: File, destination: File) {
    val remaining = files.toMutableSet()
    archive.inputStream().buffered().use { file ->
      TarArchiveInputStream(BZip2CompressorInputStream(file)).use { tar ->
        while (true) {
          val entry = tar.nextEntry ?: break
          val name = entry.name.removePrefix("$MODEL/")
          if (entry.name != "$MODEL/$name" || name !in remaining) continue
          check(entry.isFile && entry.size > 0)
          File(destination, name).outputStream().buffered().use { copy(tar, it, entry.size) }
          remaining.remove(name)
        }
      }
    }
    check(remaining.isEmpty()) { "The verified archive is missing speech model files." }
  }

  private suspend fun copy(input: InputStream, output: OutputStream, limit: Long) {
    val buffer = ByteArray(128 * 1024)
    var copied = 0L
    while (true) {
      coroutineContext.ensureActive()
      val count = input.read(buffer)
      if (count == -1) break
      copied += count
      check(copied <= limit) { "Unexpected offline speech file size." }
      output.write(buffer, 0, count)
    }
    check(copied == limit) { "The offline speech download was incomplete. Try again." }
  }

  private companion object {
    val installLock = Mutex()
    val files = setOf("encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt")
    const val MODEL = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8"
    const val URL_STRING = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/$MODEL.tar.bz2"
    const val SHA256 = "1495e91b59d7fc53ddca91f3431758ec99f8fa253fdb0e1e851be0f72b14b0f9"
    const val DOWNLOAD_BYTES = 487_211_443L
    const val REQUIRED_SPACE = 1_200_000_000L
  }
}
