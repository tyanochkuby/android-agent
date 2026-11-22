package io.github.tyanochkuby.androidagent.tasks

import android.content.Context
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

internal class TaskExecutor(context: Context) {
  private val journal = TaskJournal(context)
  private val actions = AndroidActions(context)
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  private val lock = Mutex()
  private var initialized = false
  private var current: Task? = null
  private var session: Long? = null
  private var journalFailure: Exception? = null

  suspend fun submit(request: TaskRequest): Task = command {
    initialize()
    load(request.id)?.let {
      require(it.request == request) { "This task ID belongs to a different request." }
      return@command it
    }
    check(current?.finished != false) { "Finish or cancel the current task first." }
    session = actions.foregroundSession?.id
    save(Task(request)).also { schedule() }
  }

  fun reconcile() = launchWorker {
    lock.withLock { initialize() }
  }

  suspend fun read(id: String?): Task? = command {
    initialize()
    if (id == null || current?.request?.id == id) current else load(id)
  }

  suspend fun resume(id: String): Task = command {
    initialize()
    val task = active(id)
    check(task.states.values.any { it.phase == Phase.PAUSED }) { "No paused steps to resume." }
    session = checkNotNull(actions.foregroundSession?.id) { "Unlock the device and open Android Agent." }
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
    val saved = load(null)
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

  private suspend fun load(id: String?): Task? = withContext(Dispatchers.IO) { journal.read(id) }

  private suspend fun save(task: Task): Task {
    withContext(Dispatchers.IO) { journal.save(task) }
    current = task
    return task
  }

  private fun schedule() = launchWorker { pump() }

  private suspend fun pump(): Unit = lock.withLock {
    var task = current ?: return@withLock
    if (journalFailure != null || task.finished) return@withLock
    while (true) {
      val skipped = task.request.steps.firstNotNullOfOrNull { step ->
        val phase = task.states.getValue(step.id).phase
        if (phase != Phase.QUEUED && phase != Phase.PAUSED) null
        else task.skipReason(step)?.let { step.id to it }
      } ?: break
      task = save(task.transition(skipped.first, StepState(Phase.SKIPPED, detail = skipped.second)))
    }

    while (true) {
      val step = task.nextStep() ?: break
      val confirmed = session
      if (step.action.requiresForeground && (confirmed == null || actions.foregroundSession?.id != confirmed)) {
        task = save(task.transition(step.id, foregroundPause))
        continue
      }

      task = save(task.transition(step.id, StepState(Phase.RUNNING)))
      execute(task, step, confirmed)
    }
  }

  private fun execute(task: Task, step: Step, confirmed: Long?) = launchWorker {
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

  private fun launchWorker(work: suspend () -> Unit) {
    scope.launch {
      try {
        work()
      } catch (error: CancellationException) {
        throw error
      } catch (error: Exception) {
        lock.withLock { journalFailure = error }
      }
    }
  }
}
