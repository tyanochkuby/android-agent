package io.github.tyanochkuby.androidagent

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import io.github.tyanochkuby.androidagent.tasks.AndroidActions
import io.github.tyanochkuby.androidagent.tasks.Conversation
import io.github.tyanochkuby.androidagent.tasks.TaskExecutor
import io.github.tyanochkuby.androidagent.tasks.TaskJournal
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

class MainApplication : Application(), ReactApplication {

  private val taskJournal by lazy { TaskJournal(this) }

  internal val conversation by lazy { Conversation(taskJournal) }

  internal val taskExecutor by lazy {
    TaskExecutor(taskJournal, AndroidActions(this), CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate))
  }

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          add(TaskPackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}
