package io.github.tyanochkuby.androidagent.tasks

import android.accessibilityservice.AccessibilityService
import android.app.KeyguardManager
import android.graphics.Bitmap
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import androidx.annotation.RequiresApi
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.util.UUID
import kotlin.coroutines.resume
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable

@Serializable
internal data class UiElement(
  val path: List<Int>,
  val label: String,
  val description: String?,
  val resourceId: String?,
  val className: String?,
  val editable: Boolean,
  val clickable: Boolean,
)

@Serializable
internal data class UiSnapshot(val id: String, val windowId: Int, val elements: List<UiElement>)

/** A screenshot of [app]'s window, JPEG encoded, with the snapshot read from the same window. */
internal class UiCapture(val app: String, val snapshot: UiSnapshot, val jpeg: ByteArray)

internal class UiSession(
  private val observer: WindowObserver,
  private val targetPackage: String,
  private val expiresAt: Long = SystemClock.elapsedRealtime() + 60_000,
  private val authorized: () -> Boolean = { true },
) {
  private val launchDeadline = SystemClock.elapsedRealtime() + 10_000
  private data class SelectionSnapshot(val ui: UiSnapshot, val identities: List<String>, val limits: List<Int>)

  private var snapshot: SelectionSnapshot? = null
  private var windowId: Int? = null
  @Volatile private var stopped = false

  fun hasAccess() = !stopped && authorized() && SystemClock.elapsedRealtime() < expiresAt

  fun stop() {
    stopped = true
    snapshot = null
  }

  fun observe(): UiSnapshot? = withRoot { root ->
    val elements = mutableListOf<UiElement>()
    val identities = mutableListOf<String>()
    val limits = mutableListOf<Int>()
    collect(root, emptyList(), Collected(elements, identities, limits), intArrayOf(0))
    UiSnapshot(UUID.randomUUID().toString(), root.windowId, elements).also {
      snapshot = SelectionSnapshot(it, identities, limits)
    }
  }

  /**
   * Reads the target window and takes a screenshot of that window only, so overlays and other apps stay out of it.
   * Returns null when the window is not ready or changed while it was captured; nothing is kept then. Android refuses
   * secure windows, such as password or banking screens.
   */
  @RequiresApi(34)
  suspend fun capture(): UiCapture? {
    var ui = observe() ?: return null
    var selection = snapshot ?: return null
    var result = screenshot(ui.windowId)
    if (result == AccessibilityService.ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT) {
      delay(SCREENSHOT_INTERVAL_MS)
      ui = observe() ?: return null
      selection = snapshot ?: return null
      result = screenshot(ui.windowId)
    }
    val shot = when (result) {
      is AccessibilityService.ScreenshotResult -> result
      AccessibilityService.ERROR_TAKE_SCREENSHOT_SECURE_WINDOW -> error("This app does not allow screenshots of this screen.")
      AccessibilityService.ERROR_TAKE_SCREENSHOT_INVALID_WINDOW -> return null
      else -> error("Android could not take the screenshot.")
    }
    try {
      // Discard a capture whose window changed or was acted on meanwhile, so the image matches the snapshot.
      if (snapshot !== selection) return null
      val after = observe() ?: return null
      if (after.windowId != ui.windowId || after.elements != ui.elements || snapshot?.identities != selection.identities) return null
      val jpeg = withContext(Dispatchers.Default) { encode(shot) }
      return UiCapture(targetPackage, after, jpeg)
    } finally {
      shot.hardwareBuffer.close()
    }
  }

  @RequiresApi(34)
  private suspend fun screenshot(windowId: Int): Any = suspendCancellableCoroutine { continuation ->
    observer.takeScreenshotOfWindow(
      windowId, observer.mainExecutor,
      object : AccessibilityService.TakeScreenshotCallback {
        override fun onSuccess(result: AccessibilityService.ScreenshotResult) {
          if (continuation.isActive) continuation.resume(result) else result.hardwareBuffer.close()
        }

        override fun onFailure(errorCode: Int) {
          continuation.resume(errorCode)
        }
      },
    )
  }

  @RequiresApi(34)
  private fun encode(shot: AccessibilityService.ScreenshotResult): ByteArray {
    val hardware = checkNotNull(Bitmap.wrapHardwareBuffer(shot.hardwareBuffer, shot.colorSpace)) {
      "Android could not read the screenshot."
    }
    val software = hardware.copy(Bitmap.Config.ARGB_8888, false)
    hardware.recycle()
    val scale = minOf(1f, MAX_IMAGE_SIDE.toFloat() / maxOf(software.width, software.height))
    val scaled = if (scale < 1f) {
      Bitmap.createScaledBitmap(software, (software.width * scale).toInt(), (software.height * scale).toInt(), true)
        .also { software.recycle() }
    } else software
    return ByteArrayOutputStream().use { out ->
      scaled.compress(Bitmap.CompressFormat.JPEG, 80, out)
      scaled.recycle()
      out.toByteArray()
    }
  }

  fun act(snapshotId: String, elementIndex: Int, witnessIndex: Int, text: String?): String {
    val previous = snapshot
    snapshot = null
    if (previous?.ui?.id != snapshotId) return "stale"
    val expected = previous.ui.elements.getOrNull(elementIndex)
      ?: error("This element is not in the snapshot.")
    val witness = previous.ui.elements.getOrNull(witnessIndex)
      ?: error("This element is not in the snapshot.")
    check(witness.path.take(expected.path.size) == expected.path) { "The label must belong to the target element." }
    val accepted = withRoot { root ->
      if (root.windowId != previous.ui.windowId ||
        atPath(root, witness.path, 0) {
          describe(it, witness.path, previous.limits[witnessIndex]) == witness && identity(it) == previous.identities[witnessIndex]
        } != true
      ) return@withRoot null
      atPath(root, expected.path, 0) { node ->
        if (describe(node, expected.path, previous.limits[elementIndex]) != expected || identity(node) != previous.identities[elementIndex]) {
          return@atPath null
        }
        if (text == null) {
          check(expected.clickable) { "This element does not support click." }
          node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        } else {
          require(text.length <= 500) { "Text is too long." }
          check(expected.editable) { "This element does not support text entry." }
          val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
          }
          node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        }
      }
    }
    if (accepted == null) return "stale"
    check(accepted) { "Android did not accept the action." }
    return "issued"
  }

  fun foregroundChanged(activePackage: String?) {
    if (windowId != null && activePackage != null && activePackage != targetPackage) stop()
  }

  private fun <T> withRoot(block: (AccessibilityNodeInfo) -> T): T? {
    val now = SystemClock.elapsedRealtime()
    if (!hasAccess() || observer.getSystemService(KeyguardManager::class.java).isKeyguardLocked ||
      !observer.getSystemService(PowerManager::class.java).isInteractive
    ) stop()
    check(!stopped) { "The UI session ended. Return to Android Agent to start again." }
    val root = observer.rootInActiveWindow
    if (root == null) {
      check(windowId == null && now < launchDeadline) { "The target window is unavailable." }
      return null
    }
    return useNode(root) {
      if (root.packageName?.toString() != targetPackage) {
        if (windowId != null || now >= launchDeadline) {
          stop()
          error("The target app lost the foreground. Return to Android Agent to continue.")
        }
        null
      } else {
        windowId = root.windowId
        block(root)
      }
    }
  }

  private class Collected(val elements: MutableList<UiElement>, val identities: MutableList<String>, val limits: MutableList<Int>) {
    var textLeft = TEXT_BUDGET
  }

  private fun collect(node: AccessibilityNodeInfo, path: List<Int>, into: Collected, visited: IntArray) {
    if (visited[0]++ >= 400 || path.size > 20) return
    if (node.packageName?.toString() != targetPackage) return
    // Long text, such as an expanded description, stays whole until the snapshot's text budget runs out.
    val limit = into.textLeft.coerceIn(SHORT_TEXT, LONG_TEXT)
    describe(node, path, limit)?.let {
      into.elements.add(it)
      into.identities.add(identity(node))
      into.limits.add(limit)
      into.textLeft -= it.label.length + (it.description?.length ?: 0)
    }
    for (index in 0 until node.childCount) {
      if (visited[0] >= 400) break
      childAt(node, index)?.let { child -> useNode(child) { collect(child, path + index, into, visited) } }
    }
  }

  private fun describe(node: AccessibilityNodeInfo, path: List<Int>, limit: Int): UiElement? {
    if (!node.isVisibleToUser || node.isPassword ||
      (Build.VERSION.SDK_INT >= 34 && node.isAccessibilityDataSensitive)
    ) return null
    val label = (node.text ?: node.contentDescription)?.toString().orEmpty().take(limit)
    val actions = node.actionList.map { it.id }
    val editable = node.isEnabled && AccessibilityNodeInfo.ACTION_SET_TEXT in actions
    val clickable = node.isEnabled && AccessibilityNodeInfo.ACTION_CLICK in actions
    if (label.isBlank() && !editable && !clickable) return null
    return UiElement(path, label, node.contentDescription?.toString()?.take(limit), node.viewIdResourceName, node.className?.toString(), editable, clickable)
  }

  private fun identity(node: AccessibilityNodeInfo): String {
    val digest = MessageDigest.getInstance("SHA-256")
    for (value in listOf(node.text, node.contentDescription)) {
      val text = value?.toString().orEmpty()
      digest.update(text.length.toString().toByteArray())
      digest.update(0)
      digest.update(text.toByteArray())
    }
    return android.util.Base64.encodeToString(digest.digest(), android.util.Base64.NO_WRAP)
  }

  private fun childAt(node: AccessibilityNodeInfo, index: Int): AccessibilityNodeInfo? =
    try {
      node.getChild(index)
    } catch (_: IndexOutOfBoundsException) {
      // The provider can replace the children while a live tree is being read.
      null
    }

  private fun <T> atPath(root: AccessibilityNodeInfo, path: List<Int>, depth: Int, block: (AccessibilityNodeInfo) -> T): T? {
    if (root.packageName?.toString() != targetPackage) return null
    if (depth == path.size) return block(root)
    val child = childAt(root, path[depth]) ?: return null
    return useNode(child) { atPath(child, path, depth + 1, block) }
  }

  private companion object {
    // Long enough for legible text while keeping image input small.
    const val MAX_IMAGE_SIDE = 1_568
    const val SCREENSHOT_INTERVAL_MS = 500L
    const val SHORT_TEXT = 200
    const val LONG_TEXT = 4_000
    const val TEXT_BUDGET = 16_000
  }
}

@Suppress("DEPRECATION")
internal inline fun <T> useNode(node: AccessibilityNodeInfo, read: () -> T): T =
  try { read() } finally { if (Build.VERSION.SDK_INT < 33) node.recycle() }
