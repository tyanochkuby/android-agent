package io.github.tyanochkuby.androidagent.assistant

import org.junit.Assert.assertEquals
import org.junit.Test

class EndpointerTest {
  private val quiet = 0.001f
  private val noise = 0.02f
  private val speech = 0.1f

  /** Feeds [levels] until an endpoint, returning it with the frame that produced it. */
  private fun Endpointer.run(levels: Sequence<Float>): Pair<Endpoint, Int> =
    levels.withIndex().firstNotNullOf { (frame, rms) -> accept(rms)?.let { it to frame } }

  private fun frames(ms: Int, rms: Float) = generateSequence { rms }.take(ms / Endpointer.FRAME_MS)

  /** Words of 300 ms separated by 100 ms gaps at the [background] level, as in continuous speech. */
  private fun talking(background: Float) = generateSequence { frames(300, speech) + frames(100, background) }.flatten()

  @Test
  fun `speech ends after 700 ms of silence`() {
    val endpointer = Endpointer()
    val (endpoint, frame) = endpointer.run(frames(200, quiet) + frames(1_000, speech) + generateSequence { quiet })
    assertEquals(Endpoint.SPEECH_ENDED, endpoint)
    assertEquals(59, endpointer.lastVoicedFrame)
    assertEquals(59 + 35, frame)
  }

  @Test
  fun `short pauses inside speech do not end the utterance`() {
    val endpointer = Endpointer()
    val utterance = frames(500, speech) + frames(400, quiet) + frames(500, speech)
    val (endpoint, _) = endpointer.run(frames(100, quiet) + utterance + generateSequence { quiet })
    assertEquals(Endpoint.SPEECH_ENDED, endpoint)
    assertEquals(74, endpointer.lastVoicedFrame)
  }

  @Test
  fun `silence and steady background noise give up after 5 s`() {
    for (level in listOf(quiet, noise)) {
      assertEquals(Endpoint.NO_SPEECH to 249, Endpointer().run(generateSequence { level }))
    }
  }

  @Test
  fun `a click does not start speech`() {
    val (endpoint, _) = Endpointer().run(frames(200, quiet) + frames(40, speech) + generateSequence { quiet })
    assertEquals(Endpoint.NO_SPEECH, endpoint)
  }

  @Test
  fun `speech is capped at 15 s`() {
    assertEquals(Endpoint.TOO_LONG to 749, Endpointer().run(frames(100, quiet) + talking(quiet)))
  }

  @Test
  fun `speech over background noise ends when only noise remains`() {
    val (endpoint, _) = Endpointer().run(frames(300, noise) + talking(noise).take(100) + generateSequence { noise })
    assertEquals(Endpoint.SPEECH_ENDED, endpoint)
  }
}
