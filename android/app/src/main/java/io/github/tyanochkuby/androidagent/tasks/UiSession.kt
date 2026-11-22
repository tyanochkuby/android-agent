package io.github.tyanochkuby.androidagent.tasks

import android.app.KeyguardManager
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import java.security.MessageDigest
import java.util.UUID
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

internal class UiSession(
  private val observer: WindowObserver,
  private val targetPackage: String,
) {
  private val launchDeadline = SystemClock.elapsedRealtime() + 10_000
  private val expiresAt = SystemClock.elapsedRealtime() + 60_000
  private data class SelectionSnapshot(val ui: UiSnapshot, val identities: List<String>)

  private var snapshot: SelectionSnapshot? = null
  private var windowId: Int? = null
  private var stopped = false

  fun stop() {
    stopped = true
    snapshot = null
  }

  fun observe(): UiSnapshot? = withRoot { root ->
    val elements = mutableListOf<UiElement>()
    val identities = mutableListOf<String>()
    collect(root, emptyList(), elements, identities, intArrayOf(0))
    UiSnapshot(UUID.randomUUID().toString(), root.windowId, elements).also {
      snapshot = SelectionSnapshot(it, identities)
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
          describe(it, witness.path) == witness && identity(it) == previous.identities[witnessIndex]
        } != true
      ) return@withRoot null
      atPath(root, expected.path, 0) { node ->
        if (describe(node, expected.path) != expected || identity(node) != previous.identities[elementIndex]) {
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
    if (now >= expiresAt || observer.getSystemService(KeyguardManager::class.java).isKeyguardLocked ||
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

  private fun collect(node: AccessibilityNodeInfo, path: List<Int>, elements: MutableList<UiElement>, identities: MutableList<String>, visited: IntArray) {
    if (visited[0]++ >= 400 || path.size > 20) return
    if (node.packageName?.toString() != targetPackage) return
    describe(node, path)?.let {
      elements.add(it)
      identities.add(identity(node))
    }
    for (index in 0 until node.childCount) {
      if (visited[0] >= 400) break
      node.getChild(index)?.let { child -> useNode(child) { collect(child, path + index, elements, identities, visited) } }
    }
  }

  private fun describe(node: AccessibilityNodeInfo, path: List<Int>): UiElement? {
    if (!node.isVisibleToUser || node.isPassword ||
      (Build.VERSION.SDK_INT >= 34 && node.isAccessibilityDataSensitive)
    ) return null
    val label = (node.text ?: node.contentDescription)?.toString().orEmpty().take(200)
    val actions = node.actionList.map { it.id }
    val editable = node.isEnabled && AccessibilityNodeInfo.ACTION_SET_TEXT in actions
    val clickable = node.isEnabled && AccessibilityNodeInfo.ACTION_CLICK in actions
    if (label.isBlank() && !editable && !clickable) return null
    return UiElement(path, label, node.contentDescription?.toString()?.take(200), node.viewIdResourceName, node.className?.toString(), editable, clickable)
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

  private fun <T> atPath(root: AccessibilityNodeInfo, path: List<Int>, depth: Int, block: (AccessibilityNodeInfo) -> T): T? {
    if (root.packageName?.toString() != targetPackage) return null
    if (depth == path.size) return block(root)
    val child = root.getChild(path[depth]) ?: return null
    return useNode(child) { atPath(child, path, depth + 1, block) }
  }
}

@Suppress("DEPRECATION")
internal inline fun <T> useNode(node: AccessibilityNodeInfo, read: () -> T): T =
  try { read() } finally { if (Build.VERSION.SDK_INT < 33) node.recycle() }
