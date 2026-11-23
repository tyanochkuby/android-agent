package io.github.tyanochkuby.androidagent.tasks

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
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

    val recovered = executor.submit(request)
    runCurrent()

    assertEquals(Phase.UNKNOWN, recovered.states.getValue(timer.id).phase)
    assertEquals(Phase.UNKNOWN, journal.task?.states?.get(timer.id)?.phase)
    assertEquals(Phase.SKIPPED, journal.task?.states?.get(open.id)?.phase)
    assertTrue(actions.dispatched.isEmpty())
  }

  @Test
  fun `listing after a restart pages through recorded calls newest first without dispatching`() = runTest {
    fun call(id: String, seconds: Int, vararg phases: Phase) =
      phases.fold(Task(TaskRequest(id, listOf(Step("timer", Action.StartTimer(seconds)))))) { task, phase ->
        task.transition("timer", StepState(phase))
      }
    val journal = MemoryJournal(
      call("first", 90, Phase.RUNNING, Phase.ISSUED),
      call("second", 30, Phase.RUNNING, Phase.FAILED),
      call("third", 45, Phase.RUNNING),
    )
    val actions = FakeActions()
    val context = backgroundScope.coroutineContext
    val restarted = TaskExecutor(journal, actions, CoroutineScope(context + SupervisorJob(context[Job])))

    val page = restarted.list(null, 2)
    val rest = restarted.list(page.last().request.id, 2)
    runCurrent()

    assertEquals(listOf("third", "second"), page.map { it.request.id })
    assertEquals(listOf("first"), rest.map { it.request.id })
    assertEquals(Phase.UNKNOWN, page.first().states.getValue("timer").phase)
    assertEquals(call("first", 90, Phase.RUNNING, Phase.ISSUED), rest.single())
    assertTrue(restarted.list("first", 2).isEmpty())
    assertTrue(runCatching { restarted.list("missing", 2) }.exceptionOrNull() is IllegalArgumentException)
    runCurrent()
    assertTrue(actions.dispatched.isEmpty())
  }

  @Test
  fun `a completed request keeps its result and rejects a changed payload after restart`() = runTest {
    val journal = MemoryJournal()
    val originalActions = FakeActions()
    val request = TaskRequest("task", listOf(timer))
    TaskExecutor(journal, originalActions, backgroundScope).submit(request)
    runCurrent()
    val saved = checkNotNull(journal.task)
    assertEquals(Phase.ISSUED, saved.states.getValue(timer.id).phase)
    assertEquals(listOf(timer.id), originalActions.dispatched)

    val restartedActions = FakeActions()
    val context = backgroundScope.coroutineContext
    val restartScope = CoroutineScope(context + SupervisorJob(context[Job]))
    val restarted = TaskExecutor(journal, restartedActions, restartScope)
    assertEquals(saved, restarted.submit(request))
    val modified = request.copy(steps = listOf(timer.copy(action = Action.StartTimer(120))))
    val rejection = runCatching { restarted.submit(modified) }.exceptionOrNull()
    assertTrue(rejection is IllegalArgumentException)
    runCurrent()
    assertEquals(saved, journal.task)
    assertTrue(restartedActions.dispatched.isEmpty())
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
          interruptedAction.copy(result = evidence)
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
      assertEquals(Phase.UNKNOWN, recovered.states.getValue(open.id).phase)
      assertEquals(evidence, recovered.states.getValue(open.id).result)
      runCurrent()
      assertEquals(Phase.SKIPPED, journal.task?.states?.get(timer.id)?.phase)
      assertTrue(actions.dispatched.isEmpty())
    }
  }

  private class MemoryJournal(vararg saved: Task) : TaskStore {
    private val tasks = saved.toMutableList()
    val task get() = tasks.lastOrNull()
    var rejectRunningWrite = false

    override suspend fun read(id: String?) = if (id == null) task else tasks.find { it.request.id == id }

    override suspend fun save(task: Task) {
      check(!rejectRunningWrite || task.states.values.none { it.phase == Phase.RUNNING })
      val index = tasks.indexOfFirst { it.request.id == task.request.id }
      if (index < 0) tasks += task else tasks[index] = task
    }

    override suspend fun list(before: String?, limit: Int) =
      tasks.takeWhile { it.request.id != before }.reversed().take(limit)
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
