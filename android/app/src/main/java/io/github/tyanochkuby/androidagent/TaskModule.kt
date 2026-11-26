package io.github.tyanochkuby.androidagent

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import io.github.tyanochkuby.androidagent.assistant.SpeechModel
import io.github.tyanochkuby.androidagent.assistant.VoiceTurns
import io.github.tyanochkuby.androidagent.tasks.Phase
import io.github.tyanochkuby.androidagent.tasks.UiSession
import io.github.tyanochkuby.androidagent.tasks.WindowObserver
import io.github.tyanochkuby.androidagent.tasks.TaskRequest
import io.github.tyanochkuby.androidagent.tasks.taskJson
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

class TaskModule(private val context: ReactApplicationContext) : NativeTasksSpec(context) {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  private val application = context.applicationContext as MainApplication
  private val executor = application.taskExecutor
  private val conversation = application.conversation
  private val chatgpt = application.chatgpt

  // Turns run in JavaScript, so a turn still running when this runtime starts was interrupted.
  private val recoveryLock = Mutex()
  private var recovered = false

  private suspend fun recoverConversation() = recoveryLock.withLock {
    if (!recovered) {
      conversation.interruptRunning()
      recovered = true
    }
  }

  override fun getName() = NAME

  override fun submit(request: String, turn: String?, promise: Promise) = respond(promise) {
    check(uiSession == null) { "Close the UI workflow before submitting another task." }
    require(request.length <= 65_536) { "Task request is too large." }
    val parsed = taskJson.decodeFromString<TaskRequest>(request)
    parsed.validate()
    if (turn != null) recoverConversation()
    taskJson.encodeToString(executor.submit(parsed, turn))
  }

  override fun read(id: String?, promise: Promise) = respond(promise) {
    executor.read(id)?.let { taskJson.encodeToString(it) }
  }

  override fun list(before: String?, limit: Double, promise: Promise) = respond(promise) {
    require(limit in 1.0..20.0 && limit % 1 == 0.0) { "Use a limit from 1 to 20." }
    taskJson.encodeToString(executor.list(before, limit.toInt()))
  }

  override fun readConversation(before: String?, limit: Double, promise: Promise) = respond(promise) {
    require(limit in 1.0..20.0 && limit % 1 == 0.0) { "Use a limit from 1 to 20." }
    recoverConversation()
    taskJson.encodeToString(conversation.read(before, limit.toInt()))
  }

  override fun readCompletedTurns(after: String?, limit: Double, promise: Promise) = respond(promise) {
    require(limit in 1.0..20.0 && limit % 1 == 0.0) { "Use a limit from 1 to 20." }
    recoverConversation()
    taskJson.encodeToString(conversation.readCompleted(after, limit.toInt()))
  }

  override fun readCheckpoint(promise: Promise) = respond(promise) {
    recoverConversation()
    conversation.readCheckpoint()?.let { taskJson.encodeToString(it) }
  }

  override fun saveCheckpoint(summary: String, covers: String, promise: Promise) = respond(promise) {
    recoverConversation()
    conversation.saveCheckpoint(summary, covers)
    null
  }

  override fun startTurn(prompt: String, attempt: String, owner: String?, promise: Promise) = respond(promise) {
    recoverConversation()
    conversation.start(prompt, attempt, owner)
  }

  override fun completeTurn(id: String, reply: String, promise: Promise) = respond(promise) {
    recoverConversation()
    conversation.complete(id, reply)
    null
  }

  override fun failTurn(id: String, detail: String, promise: Promise) = respond(promise) {
    recoverConversation()
    conversation.fail(id, detail)
    null
  }

  // Connection settings stay on the device so a voice turn can run while Android Agent is closed.
  private val preferences = context.getSharedPreferences(SETTINGS, Context.MODE_PRIVATE)

  override fun readSettings(promise: Promise) = respond(promise) {
    preferences.getString(SETTINGS, null)
  }

  override fun saveSettings(settings: String, promise: Promise) = respond(promise) {
    check(preferences.edit().putString(SETTINGS, settings).commit()) { "Could not save the settings." }
    null
  }

  private val speechModel by lazy { SpeechModel(application) }

  override fun speechModelStatus(promise: Promise) = respond(promise) {
    if (!context.resources.getBoolean(R.bool.assistant_prototype_enabled)) null
    else if (speechModel.installed) "ready" else "missing"
  }

  override fun installSpeechModel(promise: Promise) = respond(promise) {
    check(context.resources.getBoolean(R.bool.assistant_prototype_enabled))
    speechModel.install()
    null
  }

  override fun chatgptStatus(promise: Promise) = respond(promise) {
    chatgpt.status()?.let { taskJson.encodeToString(it) }
  }

  override fun chatgptSignIn(promise: Promise) = respond(promise) {
    val connection = chatgpt.signIn { url ->
      val activity = checkNotNull(MainActivity.foregroundSession?.activity) { "Open Android Agent first." }
      activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
    }
    taskJson.encodeToString(connection)
  }

  override fun chatgptCancelSignIn(promise: Promise) = respond(promise) {
    chatgpt.cancelSignIn()
    null
  }

  override fun chatgptConnect(promise: Promise) = respond(promise) {
    taskJson.encodeToString(chatgpt.connect())
  }

  override fun chatgptSignOut(promise: Promise) = respond(promise) {
    chatgpt.signOut().toString()
  }

  override fun chatgptRespond(
    account: String, instructions: String, input: String, shareHistory: Boolean, promise: Promise,
  ) = respond(promise) {
    val reply = chatgpt.respond(account, instructions, input) {
      !shareHistory || canShareHistory(account)
    }
    buildJsonObject {
      put("text", reply.text)
      put("inputTokens", reply.inputTokens)
    }.toString()
  }

  private fun canShareHistory(account: String): Boolean {
    val saved = preferences.getString(SETTINGS, null) ?: return false
    val config = taskJson.parseToJsonElement(saved).jsonObject
    if (config["shareHistory"]?.jsonPrimitive?.booleanOrNull != true) return false
    val session = config["session"]?.jsonObject ?: return false
    return session["chatgpt"]?.jsonPrimitive?.booleanOrNull == true &&
      session["id"]?.jsonPrimitive?.contentOrNull == account
  }

  override fun finishVoiceTurn(id: String, text: String, failed: Boolean, promise: Promise) = respond(promise) {
    VoiceTurns.finish(id, text, failed)
    null
  }

  override fun waitForTask(id: String, promise: Promise) = respond(promise) {
    val deadline = SystemClock.elapsedRealtime() + 5_000
    var task = checkNotNull(executor.read(id)) { "Task status is unavailable." }
    while (!task.finished && task.states.values.none { it.phase == Phase.PAUSED } &&
      SystemClock.elapsedRealtime() < deadline
    ) {
      delay(100)
      task = checkNotNull(executor.read(id)) { "Task status is unavailable." }
    }
    taskJson.encodeToString(task)
  }

  override fun resume(id: String, promise: Promise) = respond(promise) {
    check(uiSession == null) { "Close the UI workflow before resuming another task." }
    taskJson.encodeToString(executor.resume(id))
  }

  override fun cancel(id: String, promise: Promise) = respond(promise) {
    taskJson.encodeToString(executor.cancel(id))
  }

  override fun openAccessibilitySettings(promise: Promise) = respond(promise) {
    val activity = checkNotNull(MainActivity.foregroundSession?.activity) { "Open Android Agent first." }
    activity.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
    null
  }

  private var uiSession: UiSession? = null

  override fun startUi(app: String, promise: Promise) = respond(promise) {
    check(uiSession == null) { "Close the current UI session first." }
    val observer = checkNotNull(WindowObserver.connected) { "Enable Android Agent in Accessibility settings." }
    val foreground = checkNotNull(MainActivity.foregroundSession) { "Open Android Agent first." }
    require(app.matches(PACKAGE_NAME) && app != foreground.activity.packageName) { "Choose a valid external app." }
    val session = UiSession(observer, app)
    uiSession = session
    try {
      check(executor.read(null)?.finished != false) { "Finish the current task first." }
      check(MainActivity.foregroundSession === foreground && WindowObserver.connected === observer && uiSession === session) {
        "Return to Android Agent and start the workflow again."
      }
      val activity = foreground.activity
      if (Build.VERSION.SDK_INT >= 33) {
        activity.startIntentSender(activity.packageManager.getLaunchIntentSenderForPackage(app), null, 0, 0, 0)
      } else {
        val launch = checkNotNull(activity.packageManager.getLaunchIntentForPackage(app)) { "Install the target app first." }
        activity.startActivity(launch)
      }
      observer.session = session
      null
    } catch (error: Exception) {
      if (uiSession === session) closeUi()
      throw error
    }
  }

  override fun observeUi(promise: Promise) = respond(promise) {
    val session = checkNotNull(uiSession)
    // React Native timers can pause when the target app opens.
    delay(250)
    session.observe()?.let { taskJson.encodeToString(it) }
  }

  override fun actUi(snapshot: String, element: Double, witness: Double, text: String?, promise: Promise) = respond(promise) {
    require(element in 0.0..399.0 && element % 1 == 0.0)
    require(witness in 0.0..399.0 && witness % 1 == 0.0)
    checkNotNull(uiSession).act(snapshot, element.toInt(), witness.toInt(), text)
  }

  override fun stopUi(promise: Promise) = respond(promise) {
    closeUi()
    null
  }

  private fun closeUi() {
    uiSession?.stop()
    val observer = WindowObserver.connected
    if (observer?.session === uiSession) observer?.session = null
    uiSession = null
  }

  override fun invalidate() {
    VoiceTurns.invalidate(context)
    closeUi()
    scope.cancel()
    super.invalidate()
  }

  private fun respond(promise: Promise, operation: suspend () -> String?) {
    scope.launch {
      try {
        promise.resolve(operation())
      } catch (error: CancellationException) {
        throw error
      } catch (error: Exception) {
        promise.reject("E_TASK", error)
      }
    }
  }

  companion object {
    private val PACKAGE_NAME = Regex("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+")
    private const val SETTINGS = "settings"
    const val NAME = "NativeTasks"
  }
}
