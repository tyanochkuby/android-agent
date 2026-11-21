package io.github.tyanochkuby.androidagent

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class TimerPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext) =
    if (name == TimerModule.NAME) TimerModule(reactContext) else null

  override fun getReactModuleInfoProvider() = ReactModuleInfoProvider {
    mapOf(
      TimerModule.NAME to ReactModuleInfo(
        name = TimerModule.NAME,
        className = TimerModule::class.java.name,
        canOverrideExistingModule = false,
        needsEagerInit = false,
        isCxxModule = false,
        isTurboModule = true,
      ),
    )
  }
}
