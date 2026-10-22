package cn.toside.music.mobile.diagnostics;

import android.app.Application;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;

/**
 * JS-facing access to the native diagnostics trail.
 * Every method resolves (never rejects) and never throws into the bridge.
 */
public class DiagnosticsModule extends ReactContextBaseJavaModule {

  public DiagnosticsModule(ReactApplicationContext reactContext) {
    super(reactContext);
    // Guarded self-wiring: works even if the MainApplication hooks are missing.
    try {
      Application app = null;
      try {
        if (reactContext.getApplicationContext() instanceof Application) {
          app = (Application) reactContext.getApplicationContext();
        }
      } catch (Throwable ignored) {
        app = null;
      }
      if (app != null) {
        DiagnosticsLog.init(app, app);
        DiagnosticsLog.startMonitoring(app);
      }
    } catch (Throwable ignored) {
      // diagnostics must never break module creation
    }
  }

  @Override
  public String getName() {
    return "DiagnosticsModule";
  }

  @ReactMethod
  public void heartbeat(double jsTs, Promise promise) {
    try {
      DiagnosticsLog.onJsAck();
      promise.resolve(true);
    } catch (Throwable ignored) {
      try {
        promise.resolve(false);
      } catch (Throwable ignored2) {
        // nothing left to do
      }
    }
  }

  @ReactMethod
  public void readLog(Promise promise) {
    String content = "";
    try {
      content = DiagnosticsLog.readLog();
    } catch (Throwable ignored) {
      content = "";
    }
    if (content == null) content = "";
    try {
      promise.resolve(content);
    } catch (Throwable ignored) {
      // nothing left to do
    }
  }

  @ReactMethod
  public void readEventLog(Promise promise) {
    String content = "";
    try {
      content = DiagnosticsLog.readEventLog();
    } catch (Throwable ignored) {
      content = "";
    }
    if (content == null) content = "";
    try {
      promise.resolve(content);
    } catch (Throwable ignored) {
      // nothing left to do
    }
  }

  @ReactMethod
  public void getStatus(Promise promise) {
    String status = "";
    try {
      status = DiagnosticsLog.getStatusString();
    } catch (Throwable ignored) {
      status = "";
    }
    if (status == null) status = "";
    try {
      promise.resolve(status);
    } catch (Throwable ignored) {
      // nothing left to do
    }
  }

  @ReactMethod
  public void addListener(String eventName) {
    // no-op: kept so a NativeEventEmitter can be constructed from JS without warnings
  }

  @ReactMethod
  public void removeListeners(int count) {
    // no-op: kept so a NativeEventEmitter can be constructed from JS without warnings
  }

  @ReactMethod
  public void log(String tag, String message) {
    try {
      DiagnosticsLog.log(tag, message);
    } catch (Throwable ignored) {
      // never throw into the bridge
    }
  }
}
