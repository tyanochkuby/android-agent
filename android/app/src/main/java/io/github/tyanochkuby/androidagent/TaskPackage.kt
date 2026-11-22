package io.github.tyanochkuby.androidagent

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class TaskPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext) =
    if (name == TaskModule.NAME) TaskModule(reactContext) else null

  override fun getReactModuleInfoProvider() = ReactModuleInfoProvider {
    mapOf(
      TaskModule.NAME to ReactModuleInfo(
        name = TaskModule.NAME,
        className = TaskModule::class.java.name,
        canOverrideExistingModule = false,
        needsEagerInit = false,
        isCxxModule = false,
        isTurboModule = true,
      ),
    )
  }
}
