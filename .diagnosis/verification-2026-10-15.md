# 验证记录：后台播放诊断埋点（2026-10-15）

范围：本次新增/修改的 JS 埋点与 Android 原生诊断模块。**无真机复现、无端到端测试**（本机无法运行 App），
以下为可在本机执行的静态与编译门禁结果，以及人工复核结论。

## 1. 门禁执行结果

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run tsc` | ✅ 通过（exit 0） |
| 变更文件 lint | `npx eslint <变更文件>` | ✅ 0 error / 0 warning |
| 全仓 lint | `npm run lint` | ✅ exit 0 |
| Android 编译 | `cd android && gradlew.bat :app:compileDebugJavaWithJavac --offline` | ✅ `BUILD SUCCESSFUL`，exit 0；`.../javac/debug/.../diagnostics/DiagnosticsLog.class`、`DiagnosticsModule.class`、`DiagnosticsPackage.class` 均产出 |
| Android 编译（追加修复后） | 同上，重新执行 | ✅ `BUILD SUCCESSFUL in 20s`，exit 0（`UtilsModule` 只有 deprecation 提示） |
| **Release 打包** | `cd android && gradlew.bat assembleRelease --offline` | ✅ `BUILD SUCCESSFUL`，**exit 0**；产出 4 个架构包 + universal（`android/app/build/outputs/apk/release/`） |
| **Release 产物内容校验** | 解包 `lx-music-mobile-v1.9.1-arm64-v8a.apk` → `assets/index.android.bundle` | ✅ 含 `playbackHeartbeat` / `PLAYBACK_SILENT` / `heartbeat gap` / `shareFile` / `lx diagnostics`，版本串 `1.9.1`（无 `1.8.4`） |
| **Debug 打包** | `gradlew.bat assembleDebug -PreactNativeArchitectures=arm64-v8a --offline` | ✅ `BUILD SUCCESSFUL in 24s`，exit 0 |
| **Debug 产物内容校验** | 解包 debug APK → `assets/index.android.bundle` | ✅ 10588533 字节（= 重新生成的 dev bundle），含新埋点与 `1.9.1` |
| **陈旧 bundle 告警** | 把 bundle mtime 改旧后运行 `:app:checkDebugJsBundleFreshness` | ✅ 打印醒目 `[WARN] 调试包内嵌的 JS bundle 已过期！`（并已验证该任务挂在 `preDebugBuild` 上） |

### 1.1 本轮修复的两个构建问题

**问题 1：`assembleRelease` 失败（*用户报告的「pack 失败」*）**

```
Error: src\utils\playbackHeartbeat.ts:Invalid call at line 71: require(path)
> Task :app:createBundleReleaseJsAndAssets FAILED
```
原因：`playbackHeartbeat.ts` 用了 `const tryRequire = (path) => require(path)` —— **Metro 无法解析变量形式的 require**。
（debug 编译不打包 JS，所以只有 release 暴露。）
修复：改为字符串字面量 require（`getProgressModule()` / `getTrackPlayer()`），保留惰性与 try/catch。
验证：`assembleRelease` 通过，APK 内 bundle 含新代码。

**问题 2：debug 包安装后应用内显示 1.8.4（*与 APK 版本 1.9.1 不一致*）**

原因：`assembleDebug` **不生成 JS bundle**，而是把 `android/app/src/main/assets/index.android.bundle`
**原样打进 APK**；该文件是 2026-09-11 手工 `npm run bundle-android` 留下的旧 dev bundle
（当时 `package.json.version = 1.8.4`）。APK 版本号来自 `package.json`（构建时读取），
应用内 `process.versions.app` 来自**内嵌 bundle**（打包 JS 时读取），于是两者不一致，
而且**新加的埋点代码根本不在运行的 bundle 里**。
修复：① 重新生成该 bundle（当前源码，dev 模式）；② 在 `android/app/build.gradle` 增加
`checkDebugJsBundleFreshness`（挂在 `preDebugBuild`），bundle 比 JS 源码旧就打印醒目告警；
③ 操作手册 5.5 节补充说明与校验方法。
验证：debug APK 内嵌 bundle 已更新为 10588533 字节且含新代码；告警分支已用改 mtime 的方式实测触发。

编译环境（实测）：AGP 8.6.1 / Gradle 8.8 / compileSdk 36 / buildTools 35.0.0 / JDK 17 / minSdk 21 / targetSdk 29；
新增依赖 `androidx.localbroadcastmanager:localbroadcastmanager:1.1.0` 在本地 Gradle 缓存中，`--offline` 可直接解析。

## 2. 关键实现复核（Lead 逐项确认）

### 2.1 JS 侧
1. **后台落盘**：`runtimeLog.scheduleFlush()` 优先使用 `react-native-background-timer`
   （原生 Handler + 事件回调，后台仍然触发），取不到才回退 `setTimeout`；`warn/error` 直接
   `void flush()`（不依赖定时器）；`doFlush()` 的 `finally` 只要还有待写内容就继续调度。
2. **跨会话证据**：`init()` 在写入本次 `[SESSION] session start` 之前先分析文件里的上一次会话；
   若非正常结束，则写一条 `WARN [SESSION] previous session did not end cleanly`，并把上一次会话
   最后 80 行以 `[PREV_SESSION_RAW]` **注入内存缓冲**（只进内存不重复写盘）。
3. **心跳**：`playbackHeartbeat` 30s 一跳（原生定时器），每跳 `flush()`；gap 判定 2.5×间隔；
   静默判定"state=Playing 且 position 20s 不前进"（重复上报间隔 60s）；
   "UI 在播/原生非 Playing"判定 30s。空闲时降频（4 跳一次）以控制日志体积。
4. **看门狗**：新增 `noteAppState()`；gap 落在后台区间时降级为 `INFO [WATCHDOG] timer gap explained by host pause`，
   不再产生 error 级假 `[STALL]`（避免掩盖真信号）。
5. **渲染存活**：`useProgress` 内 ≥5s 节流的 `[RENDER] progress rendered`；每个屏幕套 `ErrorBoundary`
   （捕获 → `[RENDER] react render error caught by boundary` + `flush()` + 可见降级页）。
6. **导出**：`buildFullDiagnostics()` = 即时状态 + 看门狗/心跳 + 内存缓冲 + 落盘全文（尾 12 万字符）
   + 原生日志（尾 6 万字符）；设置页「复制诊断信息」「分享日志」都改用它。
7. **原生桥**：`nativeModules/diagnostics.ts` 全部做"模块不存在即降级"，不抛异常；ack 循环 10s。

### 2.2 原生侧（`android/.../diagnostics/`）
1. 状态码映射已用**真实来源**核对：fork 的 `ExoPlayback.getState()` 返回
   `PlaybackStateCompat` 常量，`MusicModule.getConstants()` 把 `STATE_*` 直接映射为这些值，
   因此 **PLAYING = 3**（`utils/../ExoPlayback.java:246-257`、`module/MusicModule.java:156-162`）。
   `SILENT_PLAYBACK` 只在 `lastTpState == 3` 时判定，结论可靠。
2. 事件名/键名已与 fork 核对：action `com.guichaguri.trackplayer.event`、
   `"event"`/`"data"` 两个 extra、`playback-state/track-changed/queue-ended/error/remote-duck/metadata-received`
   及各自 bundle 键（`MusicService.emit`、`MusicManager` 各 put）。
3. `android.media.AudioPlaybackConfiguration#isActive()` **不在公开 SDK 中**（子代理用真机 android-36 stub 编译时发现，
   直接调用会编译失败）；现改为**反射 + 宽松回退**，并把 `audioActiveReflect=0|1`、
   `musicActive=0|1` 一起打进 `getStatus()`/`HEARTBEAT`/`SILENT_PLAYBACK` 行 —— 若某设备上探针不可用，
   日志本身能自证（`musicActive=1` 而 `audioActive=0` 即为"探针瞎了"，而不是真的没声音）。
4. 写盘：独立 `diag-log` HandlerThread 单写者 FIFO；每行 `FileWriter(append)+flush+close`
   （崩溃可durable）；512KB 轮转、保留 1 份；待写队列上限 500 行，超出丢弃并计数；
   所有入口 `try/catch(Throwable)`，失败绝不影响业务。
5. 生命周期：`MainApplication.onCreate` 最先 `init + startMonitoring`；`onTrimMemory/onLowMemory` 转发；
   Activity 生命周期与 `ComponentCallbacks2` 双通道；`registerReceiver`/`registerAudioPlaybackCallback` 失败会记录而非抛出。

## 3. 残余风险（首台真机首次运行时建议确认）

| # | 风险 | 观察点 |
|---|---|---|
| 1 | Android 16 上 `getActivePlaybackConfigurations()` 可能因权限返回空列表 | 若 `SILENT_PLAYBACK` 行里 `musicActive=1` 而 `audioActive=0`，说明是探针不可用而非真无声；此时以 `musicActive` 为准 |
| 2 | 反射 `isActive()` 在部分 ROM 上不可用 | 回退为"计数 > 0"，`audioActiveReflect=0` 会体现在状态行 |
| 3 | `BackgroundTimer` 在个别 ROM 后台被限制 | 若 `[HEARTBEAT]` 在后台完全缺失，则心跳机制本身受限；此时仍可依赖原生 `HEARTBEAT/JS_UNRESPONSIVE/TP` 时间线 |
| 4 | 大量日志对性能的影响 | 稳态 ≤6 行/分钟（原生）+ ≤2 行/分钟（JS，播放中）；轮转上限合计约 2.5MB |
| 5 | 新增依赖 `localbroadcastmanager:1.1.0` | 与 fork 同版本（fork `android/build.gradle:93`），`--offline` 编译已通过 |

## 4. 未验证项（诚实声明）
- 未在真机运行：`SILENT_PLAYBACK` / `JS_UNRESPONSIVE` / `PLAYBACK_SILENT` 的**实际触发**未经验证（只有逻辑与编译验证）。
- 未做 App 端到端（安装→播放→后台→导出）流程验证；建议首台设备上按 `.diagnosis/用户排查操作指南.md` 第 0 步先自检日志是否落盘。
- 未评估 `[HEARTBEAT]`/原生心跳对续航的实际影响（30s/15s 一次 Handler 唤醒，预期可忽略，但未实测）。
