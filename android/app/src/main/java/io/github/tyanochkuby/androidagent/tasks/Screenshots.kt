package io.github.tyanochkuby.androidagent.tasks

import java.io.File
import java.security.MessageDigest
import java.security.SecureRandom
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlinx.serialization.Serializable

/** A stored screenshot of [app]. [id] is opaque to the model; [capturedAt] is UTC ISO 8601. */
@Serializable
internal data class Screenshot(val id: String, val app: String, val capturedAt: String)

/** A kept [screenshot] and the accessibility snapshot read from the same window. */
@Serializable
internal data class CapturedScreen(val screenshot: Screenshot, val snapshot: UiSnapshot)

/**
 * App-private screenshots the agent captured on request, kept for follow-up turns. Each one belongs to the owner of
 * the turn that captured it, a `chatgpt:` or `companion:` connection, and only that owner can list or read it. At most
 * [limit] screenshots are kept across all owners; saving another drops the oldest. Never log their content.
 */
internal class Screenshots(
  private val root: File,
  private val clock: () -> Long = System::currentTimeMillis,
  private val limit: Int = 24,
) {
  private val random = SecureRandom()

  @Synchronized
  fun save(owner: String, app: String, jpeg: ByteArray, beforePublish: () -> Unit = {}): Screenshot {
    require(app.matches(PACKAGE_NAME)) { "Invalid app." }
    val time = clock()
    val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).apply { timeZone = UTC }.format(Date(time))
    val suffix = (1..6).map { ALPHABET[random.nextInt(ALPHABET.length)] }.joinToString("")
    val id = "s-$stamp-$suffix"
    val dir = File(root, key(owner)).apply { mkdirs() }
    val file = File(dir, "$id$SEPARATOR$app.jpg")
    val partial = File(dir, "${file.name}.partial")
    try {
      partial.writeBytes(jpeg)
      beforePublish()
      check(partial.renameTo(file)) { "Could not save the screenshot." }
      try {
        beforePublish()
      } catch (error: Exception) {
        file.delete()
        throw error
      }
    } finally {
      partial.delete()
    }
    file.setLastModified(time)
    evict()
    return Screenshot(id, app, iso(time))
  }

  /** The owner's screenshots, newest first. */
  @Synchronized
  fun list(owner: String): List<Screenshot> =
    files(File(root, key(owner))).sortedByDescending { it.name }.mapNotNull(::describe)

  /** The owner's screenshot [id] as JPEG bytes, or null when it is not theirs or no longer kept. */
  @Synchronized
  fun read(owner: String, id: String): ByteArray? {
    if (!id.matches(ID)) return null
    return files(File(root, key(owner))).firstOrNull { it.name.startsWith("$id$SEPARATOR") }?.readBytes()
  }

  @Synchronized
  fun clear() {
    root.deleteRecursively()
  }

  private fun evict() {
    val all = root.listFiles().orEmpty().flatMap(::files)
    // IDs start with their capture time, so names sort oldest first within a second's resolution.
    all.sortedWith(compareBy({ it.lastModified() }, { it.name })).dropLast(limit).forEach { it.delete() }
    root.listFiles().orEmpty().filter { it.isDirectory && it.list().isNullOrEmpty() }.forEach { it.delete() }
  }

  private fun files(dir: File) = dir.listFiles().orEmpty().filter { it.isFile && it.name.endsWith(".jpg") }

  private fun describe(file: File): Screenshot? {
    val name = file.name.removeSuffix(".jpg")
    val id = name.substringBefore(SEPARATOR)
    val app = name.substringAfter(SEPARATOR, "")
    if (!id.matches(ID) || !app.matches(PACKAGE_NAME)) return null
    return Screenshot(id, app, iso(file.lastModified()))
  }

  private fun iso(time: Long) = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).apply { timeZone = UTC }.format(Date(time))

  // Owner IDs never appear in file names.
  private fun key(owner: String) = MessageDigest.getInstance("SHA-256").digest(owner.toByteArray())
    .joinToString("") { "%02x".format(it) }.take(32)

  companion object {
    val ID = Regex("s-\\d{8}-\\d{6}-[a-z0-9]{6}")
    private val PACKAGE_NAME = Regex("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+")
    private const val ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"
    private const val SEPARATOR = "__"
    private val UTC = TimeZone.getTimeZone("UTC")
  }
}
