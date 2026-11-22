package io.github.tyanochkuby.androidagent.tasks

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

private val taskIdentifier = Regex("[A-Za-z0-9_-]{1,64}")
private const val MAX_RUNNING = 4

@Serializable
enum class FailurePolicy { FAIL_FAST, CONTINUE_INDEPENDENT }

@Serializable
enum class AppTarget { CALCULATOR, MAPS }

@Serializable
sealed interface Target {
  @Serializable @SerialName("app")
  data class App(val app: AppTarget) : Target

  @Serializable @SerialName("fromSearch")
  data class FromSearch(val stepId: String) : Target
}

@Serializable
sealed interface Action {
  @Serializable @SerialName("clock.startTimer")
  data class StartTimer(val seconds: Int) : Action

  @Serializable @SerialName("apps.search")
  data class Search(val query: String) : Action

  @Serializable @SerialName("apps.open")
  data class Open(val target: Target) : Action

  @Serializable @SerialName("apps.observe")
  data class Observe(val target: Target) : Action
}

private fun Action.target() = when (this) {
  is Action.Open -> target
  is Action.Observe -> target
  else -> null
}

val Action.requiresForeground get() = this is Action.StartTimer || this is Action.Open

@Serializable
data class Step(val id: String, val action: Action, val after: Set<String> = emptySet()) {
  val dependencies get() = after + listOfNotNull((action.target() as? Target.FromSearch)?.stepId)
}

@Serializable
data class TaskRequest(
  val id: String,
  val steps: List<Step>,
  val failurePolicy: FailurePolicy = FailurePolicy.FAIL_FAST,
) {
  fun validate() {
    require(id.matches(taskIdentifier)) { "Invalid task ID." }
    require(steps.size in 1..32) { "Submit between 1 and 32 steps." }
    val byId = steps.associateBy(Step::id)
    require(byId.size == steps.size) { "Step IDs must be unique." }
    for (step in steps) {
      require(step.id.matches(taskIdentifier)) { "Invalid step ID." }
      require(step.dependencies.all(byId::containsKey)) { "A dependency refers to an unknown step." }
      val action = step.action
      when (action) {
        is Action.StartTimer -> require(action.seconds in 1..86_400) { "Use 1 to 86400 seconds." }
        is Action.Search -> require(action.query.trim().length in 1..100) { "Invalid app search query." }
        else -> Unit
      }
      val reference = action.target() as? Target.FromSearch
      require(reference == null || byId[reference.stepId]?.action is Action.Search) {
        "An app reference must come from an app search."
      }
    }

    val remaining = steps.toMutableList()
    val visited = mutableSetOf<String>()
    while (remaining.isNotEmpty()) {
      val ready = remaining.filter { visited.containsAll(it.dependencies) }
      require(ready.isNotEmpty()) { "Dependencies contain a cycle." }
      visited.addAll(ready.map(Step::id))
      remaining.removeAll(ready.toSet())
    }
  }
}

@Serializable
sealed interface Result {
  @Serializable @SerialName("matches")
  data class Matches(val apps: List<AppTarget>) : Result

  @Serializable @SerialName("window")
  data class Window(val app: AppTarget, val active: Boolean, val observedAt: Long) : Result
}

@Serializable
enum class Phase {
  QUEUED, RUNNING, PAUSED, SUCCEEDED, ISSUED, FAILED, UNKNOWN, SKIPPED;

  val terminal get() = this in setOf(SUCCEEDED, ISSUED, FAILED, UNKNOWN, SKIPPED)
  val allowsDependents get() = this == SUCCEEDED || this == ISSUED
}

@Serializable
data class StepState(
  val phase: Phase = Phase.QUEUED,
  val result: Result? = null,
  val detail: String? = null,
)

@Serializable
data class Task(
  val request: TaskRequest,
  val states: Map<String, StepState> = request.steps.associate { it.id to StepState() },
  val cancelled: Boolean = false,
) {
  val finished get() = states.values.all { it.phase.terminal }

  fun transition(id: String, state: StepState): Task {
    val allowed = when (states.getValue(id).phase) {
      Phase.QUEUED -> setOf(Phase.RUNNING, Phase.PAUSED, Phase.SKIPPED)
      Phase.RUNNING -> setOf(Phase.PAUSED, Phase.SUCCEEDED, Phase.ISSUED, Phase.FAILED, Phase.UNKNOWN)
      Phase.PAUSED -> setOf(Phase.QUEUED, Phase.SKIPPED)
      else -> emptySet()
    }
    check(state.phase in allowed) { "Invalid transition for step $id." }
    return copy(states = states + (id to state))
  }

  fun skipReason(step: Step): String? {
    if (cancelled) return "Task cancelled."
    if (request.failurePolicy == FailurePolicy.FAIL_FAST &&
      states.values.any { it.phase == Phase.FAILED || it.phase == Phase.UNKNOWN }
    ) return "Task stopped after a step failed or had an unknown outcome."
    if (step.dependencies.any {
        val phase = states.getValue(it).phase
        phase.terminal && !phase.allowsDependents
      }
    ) return "A prerequisite did not complete."
    return null
  }

  fun nextStep(): Step? {
    val running = request.steps.filter { states.getValue(it.id).phase == Phase.RUNNING }
    if (running.size >= MAX_RUNNING) return null
    val foregroundBusy = running.any { it.action.requiresForeground }
    return request.steps.firstOrNull { step ->
      states.getValue(step.id).phase == Phase.QUEUED &&
        (!foregroundBusy || !step.action.requiresForeground) &&
        step.dependencies.all { states.getValue(it).phase.allowsDependents }
    }
  }

  fun resolve(target: Target): AppTarget = when (target) {
    is Target.App -> target.app
    is Target.FromSearch -> {
      val matches = states.getValue(target.stepId).result as Result.Matches
      require(matches.apps.size == 1) {
        if (matches.apps.isEmpty()) "No supported app matched the search."
        else "More than one app matched. Choose a specific app."
      }
      matches.apps.single()
    }
  }
}
