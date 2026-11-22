package io.github.tyanochkuby.androidagent.tasks

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class TaskTest {
  private val timer = Step("timer", Action.StartTimer(60))
  private val search = Step("find", Action.Search("Maps"))
  private val open = Step("open", Action.Open(Target.FromSearch(search.id)))

  @Test
  fun `a search reference creates a dependency regardless of submission order`() {
    val request = TaskRequest("task", listOf(open, search)).also { it.validate() }
    val running = Task(request).transition(search.id, StepState(Phase.RUNNING))
    assertNull(running.nextStep())

    val found = running.transition(search.id, StepState(Phase.SUCCEEDED, Result.Matches(listOf(AppTarget.MAPS))))
    assertEquals(open, found.nextStep())
    assertEquals(AppTarget.MAPS, found.resolve(Target.FromSearch(search.id)))
  }

  @Test
  fun `validation rejects cycles and incompatible reference types`() {
    val cyclic = search.copy(after = setOf(open.id))
    assertThrows(IllegalArgumentException::class.java) {
      TaskRequest("task", listOf(open, cyclic)).validate()
    }
    val incompatible = open.copy(action = Action.Open(Target.FromSearch(timer.id)))
    assertThrows(IllegalArgumentException::class.java) {
      TaskRequest("task", listOf(timer, incompatible)).validate()
    }
  }

  @Test
  fun `auto binding requires exactly one search result`() {
    for (apps in listOf(emptyList(), listOf(AppTarget.MAPS, AppTarget.CALCULATOR))) {
      val task = Task(TaskRequest("task", listOf(search, open)))
        .transition(search.id, StepState(Phase.RUNNING))
        .transition(search.id, StepState(Phase.SUCCEEDED, Result.Matches(apps)))
      assertThrows(IllegalArgumentException::class.java) { task.resolve(Target.FromSearch(search.id)) }
    }
  }

  @Test
  fun `the foreground slot serializes app launches without blocking an independent search`() {
    val anotherTimer = timer.copy(id = "anotherTimer")
    val task = Task(TaskRequest("task", listOf(timer, anotherTimer, search)))
      .transition(timer.id, StepState(Phase.RUNNING))
    assertEquals(search, task.nextStep())

    val completed = task.transition(timer.id, StepState(Phase.ISSUED))
    assertEquals(anotherTimer, completed.nextStep())
    assertThrows(IllegalStateException::class.java) {
      completed.transition(timer.id, StepState(Phase.RUNNING))
    }
  }

  @Test
  fun `an unknown outcome stops fail-fast but leaves independent steps under continue policy`() {
    val dependent = open.copy(after = setOf(timer.id))
    val request = TaskRequest("task", listOf(timer, search, dependent))
    val task = Task(request)
      .transition(timer.id, StepState(Phase.RUNNING))
      .transition(timer.id, StepState(Phase.UNKNOWN))
    assertNotNull(task.skipReason(search))

    val continuing = task.copy(request = request.copy(failurePolicy = FailurePolicy.CONTINUE_INDEPENDENT))
    assertNull(continuing.skipReason(search))
    assertNotNull(continuing.skipReason(dependent))
  }
}
