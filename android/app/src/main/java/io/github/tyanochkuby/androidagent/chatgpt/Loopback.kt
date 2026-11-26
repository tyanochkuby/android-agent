package io.github.tyanochkuby.androidagent.chatgpt

import java.io.Closeable
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.security.MessageDigest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext

/**
 * The sign-in redirect target on 127.0.0.1. Open it before the browser so the callback cannot
 * arrive first, and close it once sign-in ends.
 */
class Loopback : Closeable {
  private val server = ServerSocket(0, 8, InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1))).apply {
    soTimeout = 500
  }
  private val host = "127.0.0.1:${server.localPort}"
  val redirectUri = "http://$host$CALLBACK_PATH"

  /**
   * Waits for the callback carrying `state` and returns its query. Any other request is answered
   * with an error and leaves the sign-in waiting. Stops with `cancelled` checked twice a second.
   */
  suspend fun await(state: String, cancelled: () -> Boolean): Map<String, List<String>> = withContext(Dispatchers.IO) {
    var query: Map<String, List<String>>? = null
    while (query == null) {
      ensureActive()
      if (cancelled()) throw ChatGPTException("sign_in_cancelled", "Sign-in was cancelled.")
      query = try {
        server.accept().use { callback(it, state) }
      } catch (_: SocketTimeoutException) {
        null
      }
    }
    query
  }

  private fun callback(socket: Socket, state: String): Map<String, List<String>>? {
    socket.soTimeout = 5_000
    val request = runCatching { readRequest(socket) }.getOrNull()
    val target = request?.target?.takeIf {
      request.method == "GET" && request.host == host && it.substringBefore('?') == CALLBACK_PATH
    }
    val query = target?.let { runCatching { parseQuery(it.substringAfter('?', "")) }.getOrNull() }
    val returned = query?.get("state")?.singleOrNull()
    val matches = returned != null && MessageDigest.isEqual(returned.toByteArray(), state.toByteArray())
    runCatching {
      if (matches) reply(socket, 200, "You can close this page and return to Android Agent.")
      else reply(socket, 400, "This sign-in link is not valid. Return to Android Agent and try again.")
    }
    return if (matches) query else null
  }

  override fun close() = server.close()
}

private class Request(val method: String, val target: String, val host: String?)

private fun readRequest(socket: Socket): Request {
  val input = socket.getInputStream().bufferedReader(Charsets.ISO_8859_1)
  val lines = generateSequence { input.readLine() }.takeWhile { it.isNotEmpty() }.take(100).toList()
  require(lines.sumOf { it.length } < 16_384)
  val (method, target) = lines.first().split(' ').let { it[0] to it[1] }
  val host = lines.drop(1).firstOrNull { it.startsWith("host:", ignoreCase = true) }?.substringAfter(':')?.trim()
  return Request(method, target, host)
}

private fun reply(socket: Socket, status: Int, message: String) {
  val body = "<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\">" +
    "<title>Android Agent</title><p style=\"font:18px sans-serif;margin:2em\">$message</p>"
  val bytes = body.toByteArray()
  val head = "HTTP/1.1 $status ${if (status == 200) "OK" else "Bad Request"}\r\n" +
    "Content-Type: text/html; charset=utf-8\r\nContent-Length: ${bytes.size}\r\n" +
    "Cache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n"
  socket.getOutputStream().apply {
    write(head.toByteArray())
    write(bytes)
    flush()
  }
}
