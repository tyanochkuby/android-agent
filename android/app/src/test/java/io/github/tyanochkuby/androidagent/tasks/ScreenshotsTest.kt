package io.github.tyanochkuby.androidagent.tasks

import java.nio.file.Files
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ScreenshotsTest {
  private val root = Files.createTempDirectory("screenshots").toFile()
  private var now = 1_795_000_000_000L
  private val store = Screenshots(root, { now }, limit = 2)

  @Test
  fun `only the owner lists and reads a screenshot`() {
    val saved = store.save("chatgpt:a", "com.example.app", byteArrayOf(1))
    assertTrue(saved.id.matches(Screenshots.ID))
    assertEquals(listOf(saved), store.list("chatgpt:a"))
    assertArrayEquals(byteArrayOf(1), store.read("chatgpt:a", saved.id))
    assertEquals(emptyList<Screenshot>(), store.list("chatgpt:b"))
    assertNull(store.read("chatgpt:b", saved.id))
    assertNull(store.read("chatgpt:a", "../${saved.id}"))
    assertTrue(root.walk().none { "chatgpt" in it.name })
  }

  @Test
  fun `keeps the newest screenshots across owners and clears them all`() {
    val oldest = store.save("chatgpt:a", "com.example.app", byteArrayOf(1))
    now += 1_000
    val middle = store.save("companion:b", "com.example.app", byteArrayOf(2))
    now += 1_000
    val newest = store.save("chatgpt:a", "com.example.other", byteArrayOf(3))
    assertNull(store.read("chatgpt:a", oldest.id))
    assertEquals(listOf(newest), store.list("chatgpt:a"))
    assertEquals(listOf(middle), store.list("companion:b"))
    store.clear()
    assertEquals(emptyList<Screenshot>(), store.list("chatgpt:a"))
  }
}
