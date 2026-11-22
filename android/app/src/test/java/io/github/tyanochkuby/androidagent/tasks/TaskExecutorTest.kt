package io.github.tyanochkuby.androidagent.tasks

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class TaskExecutorTest {
  private val timer = Step("timer", Action.StartTimer(60))
  private val open = Step("open", Action.Open(Target.App(AppTarget.MAPS)))
  private val observe = Step("observe", Action.Observe(Target.App(AppTarget.MAPS)))

  @Test
  fun `the running state must be durable before dispatch`() = runTest {
    val journal = MemoryJournal().apply { rejectRunningWrite = true }
    val actions = FakeActions()
    val executor = TaskExecutor(journal, actions, backgroundScope)

    executor.submit(TaskRequest("task", listOf(timer)))
    runCurrent()

    assertEquals(Phase.QUEUED, journal.task?.states?.get(timer.id)?.phase)
    assertTrue(actions.dispatched.isEmpty())
  }

  @Test
  fun `reopening a journal with an interrupted timer does not replay it`() = runTest {
    val request = TaskRequest("task", listOf(timer, open.copy(after = setOf(timer.id))))
    val journal = MemoryJournal(Task(request).transition(timer.id, StepState(Phase.RUNNING)))
    val actions = FakeActions()
    val executor = TaskExecutor(journal, actions, backgroundScope)

    executor.read(null)
    runCurrent()

    assertEquals(Phase.UNKNOWN, journal.task?.states?.get(timer.id)?.phase)
    assertEquals(Phase.SKIPPED, journal.task?.states?.get(open.id)?.phase)
    assertTrue(actions.dispatched.isEmpty())
  }

  @Test
  fun `cancelling during verification retains the issued action result`() = runTest {
    val verification = CompletableDeferred<StepState>()
    val journal = MemoryJournal()
    val actions = FakeActions { verification.await() }
    val executor = TaskExecutor(journal, actions, backgroundScope)

    executor.submit(TaskRequest("task", listOf(open, timer)))
    runCurrent()
    assertEquals(listOf(open.id), actions.dispatched)

    val cancelled = executor.cancel("task")
    assertEquals(Phase.RUNNING, cancelled.states.getValue(open.id).phase)
    assertEquals(Phase.SKIPPED, cancelled.states.getValue(timer.id).phase)
    assertFalse(cancelled.finished)
    val evidence = Result.Window(AppTarget.MAPS, active = true, observedAt = 1)
    verification.complete(StepState(Phase.SUCCEEDED, evidence))
    runCurrent()

    assertEquals(evidence, journal.task?.states?.get(open.id)?.result)
    assertEquals(listOf(open.id), actions.dispatched)
  }

  @Test
  fun `an immediate failure is recorded before the next independent side effect`() = runTest {
    val journal = MemoryJournal()
    val actions = FakeActions { StepState(Phase.FAILED) }
    val executor = TaskExecutor(journal, actions, backgroundScope)

    executor.submit(TaskRequest("task", listOf(observe, timer)))
    runCurrent()

    assertEquals(Phase.FAILED, journal.task?.states?.get(observe.id)?.phase)
    assertEquals(Phase.SKIPPED, journal.task?.states?.get(timer.id)?.phase)
    assertEquals(listOf(observe.id), actions.dispatched)
  }

  @Test
  fun `a different foreground session requires explicit continuation`() = runTest {
    val observation = CompletableDeferred<StepState>()
    val journal = MemoryJournal()
    val actions = FakeActions { step ->
      if (step == observe) observation.await() else StepState(Phase.ISSUED)
    }
    val executor = TaskExecutor(journal, actions, backgroundScope)

    executor.submit(TaskRequest("task", listOf(observe, timer.copy(after = setOf(observe.id)))))
    runCurrent()
    actions.foregroundSessionId = 2
    observation.complete(StepState(Phase.SUCCEEDED))
    runCurrent()
    assertEquals(Phase.PAUSED, journal.task?.states?.get(timer.id)?.phase)

    executor.resume("task")
    runCurrent()
    assertEquals(Phase.ISSUED, journal.task?.states?.get(timer.id)?.phase)
    assertEquals(listOf(observe.id, timer.id), actions.dispatched)
  }

  @Test
  fun `recovery keeps evidence whether the read or verifier arrives first`() = runTest {
    val evidence = Result.Window(AppTarget.MAPS, active = true, observedAt = 1)
    for (readFirst in listOf(true, false)) {
      val connected = CompletableDeferred<Unit>()
      val request = TaskRequest("task", listOf(open, timer.copy(after = setOf(open.id))))
      val journal = MemoryJournal(Task(request).transition(open.id, StepState(Phase.RUNNING)))
      val actions = FakeActions().apply {
        recoverOutcome = {
          connected.await()
          StepState(Phase.SUCCEEDED, evidence)
        }
      }
      val executor = TaskExecutor(journal, actions, backgroundScope)
      if (!readFirst) {
        connected.complete(Unit)
        executor.reconcile()
      }
      val read = async { executor.read(null) }
      runCurrent()
      if (readFirst) {
        assertFalse(read.isCompleted)
        connected.complete(Unit)
        executor.reconcile()
      }

      val recovered = checkNotNull(read.await())
      assertEquals(evidence, recovered.states.getValue(open.id).result)
      assertEquals(Phase.PAUSED, recovered.states.getValue(timer.id).phase)
      assertTrue(actions.dispatched.isEmpty())
    }
  }

  private class MemoryJournal(var task: Task? = null) : TaskStore {
    var rejectRunningWrite = false

    override suspend fun read(id: String?) = task?.takeIf { id == null || id == it.request.id }

    override suspend fun save(task: Task) {
      check(!rejectRunningWrite || task.states.values.none { it.phase == Phase.RUNNING })
      this.task = task
    }
  }

  private class FakeActions(
    private val outcome: suspend (Step) -> StepState = { StepState(Phase.ISSUED) },
  ) : TaskActions {
    override var foregroundSessionId: Long? = 1
    val dispatched = mutableListOf<String>()
    var recoverOutcome: suspend () -> StepState = { interruptedAction }

    override suspend fun execute(task: Task, step: Step, session: Long?): StepState {
      dispatched += step.id
      return outcome(step)
    }

    override suspend fun recover(task: Task, step: Step) = recoverOutcome()
  }
}
