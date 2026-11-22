package io.github.tyanochkuby.androidagent.tasks

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

internal interface TaskStore {
  suspend fun read(id: String?): Task?
  suspend fun save(task: Task)
}

internal interface TaskActions {
  val foregroundSessionId: Long?
  suspend fun execute(task: Task, step: Step, session: Long?): StepState
  fun recover(task: Task, step: Step): StepState
}

internal class TaskExecutor(
  private val journal: TaskStore,
  private val actions: TaskActions,
  private val scope: CoroutineScope,
) {
  private val lock = Mutex()
  private var initialized = false
  private var current: Task? = null
  private var session: Long? = null
  private var journalFailure: Exception? = null

  suspend fun submit(request: TaskRequest): Task = command {
    initialize()
    journal.read(request.id)?.let {
      require(it.request == request) { "This task ID belongs to a different request." }
      return@command it
    }
    check(current?.finished != false) { "Finish or cancel the current task first." }
    session = actions.foregroundSessionId
    save(Task(request)).also { schedule() }
  }

  fun reconcile() = launchWorker {
    lock.withLock { initialize() }
  }

  suspend fun read(id: String?): Task? = command {
    initialize()
    if (id == null || current?.request?.id == id) current else journal.read(id)
  }

  suspend fun resume(id: String): Task = command {
    initialize()
    val task = active(id)
    check(task.states.values.any { it.phase == Phase.PAUSED }) { "No paused steps to resume." }
    session = checkNotNull(actions.foregroundSessionId) { "Unlock the device and open Android Agent." }
    val resumed = task.request.steps.fold(task) { next, step ->
      if (next.states.getValue(step.id).phase == Phase.PAUSED) next.transition(step.id, StepState())
      else next
    }
    save(resumed).also { schedule() }
  }

  suspend fun cancel(id: String): Task = command {
    initialize()
    val task = active(id)
    if (task.finished || task.cancelled) return@command task
    val cancelled = task.request.steps.fold(task.copy(cancelled = true)) { next, step ->
      val phase = next.states.getValue(step.id).phase
      if (phase == Phase.QUEUED || phase == Phase.PAUSED) {
        next.transition(step.id, StepState(Phase.SKIPPED, detail = "Task cancelled."))
      } else next
    }
    save(cancelled)
  }

  private suspend fun <T> command(block: suspend () -> T): T =
    scope.async { lock.withLock { block() } }.await()

  private fun active(id: String) =
    checkNotNull(current?.takeIf { it.request.id == id }) { "This task is no longer current." }

  private suspend fun initialize() {
    journalFailure?.let { throw IllegalStateException("Task journal failed. Restart Android Agent.", it) }
    if (initialized) return
    val saved = journal.read(null)
    if (saved != null) {
      val recovered = saved.request.steps.fold(saved) { next, step ->
        val phase = next.states.getValue(step.id).phase
        when (phase) {
          Phase.RUNNING -> next.transition(step.id, actions.recover(next, step))
          Phase.QUEUED -> next.transition(step.id, foregroundPause)
          else -> next
        }
      }
      if (recovered != saved) save(recovered) else current = saved
    }
    initialized = true
    schedule()
  }

  private suspend fun save(task: Task): Task {
    journal.save(task)
    current = task
    return task
  }

  private fun schedule() = launchWorker { pump() }

  private suspend fun pump() {
    while (lock.withLock { advance() }) {
      // Let completed calls record their outcomes before reserving another slot.
    }
  }

  private suspend fun advance(): Boolean {
    var task = current ?: return false
    if (journalFailure != null || task.finished) return false
    while (true) {
      val skipped = task.request.steps.firstNotNullOfOrNull { step ->
        val phase = task.states.getValue(step.id).phase
        if (phase != Phase.QUEUED && phase != Phase.PAUSED) null
        else task.skipReason(step)?.let { step.id to it }
      } ?: break
      task = save(task.transition(skipped.first, StepState(Phase.SKIPPED, detail = skipped.second)))
    }

    val step = task.nextStep() ?: return false
    val confirmed = session
    if (step.action.requiresForeground && (confirmed == null || actions.foregroundSessionId != confirmed)) {
      save(task.transition(step.id, foregroundPause))
      return true
    }

    val running = save(task.transition(step.id, StepState(Phase.RUNNING)))
    execute(running, step, confirmed)
    return true
  }

  private fun execute(task: Task, step: Step, confirmed: Long?) = launchWorker(CoroutineStart.UNDISPATCHED) {
    val outcome = try {
      actions.execute(task, step, confirmed)
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      if (step.action.requiresForeground) interruptedAction
      else StepState(Phase.FAILED, detail = "The app could not complete this observation.")
    }
    lock.withLock {
      if (journalFailure != null) return@withLock
      val latest = active(task.request.id)
      if (step.action.requiresForeground && session == confirmed &&
        outcome.phase in setOf(Phase.ISSUED, Phase.SUCCEEDED, Phase.UNKNOWN)
      ) {
        session = null
      }
      save(latest.transition(step.id, outcome))
    }
    pump()
  }

  private fun launchWorker(start: CoroutineStart = CoroutineStart.DEFAULT, work: suspend () -> Unit) {
    scope.launch(start = start) {
      try {
        work()
      } catch (error: CancellationException) {
        throw error
      } catch (error: Exception) {
        journalFailure = error
      }
    }
  }
}
