# 移动端「后台播放突然无声、进度不动、切回前台界面空白」——本次日志分析 + 埋点修复

- 输入证据：`E:\temp\log\lxmusic\` 下 3 份导出日志 + 2 张截图（另有两份与日志 4/5 完全相同的"分享日志"）
- 设备：REDMI K90 Pro Max / Android 16；「启用音频卸载」= 开；「最大缓存大小」= 1024 MiB；开着悬浮（桌面）歌词
- 复现特征（用户描述）：应用在**后台**播放时突然无声；状态仍显示"正在播放"；进度条不动；切歌无效；歌词仍显示但不动；切回前台界面全白；杀进程重开恢复。后台最短数分钟即可复现，玩游戏时一局 15 分钟内有时能复现两次。
- 结论（先给结论）：**这三份日志在结构上不可能支持定位**——它们只包含"重启之后新进程的 15~22 秒"。原因不是一个 bug，而是三处互相叠加的采集缺陷，本次已全部修复。

---

## 一、证据本身说明了什么

### 1.1 三份日志的真实内容

| 文件 | export time | 进程启动 | 覆盖时长 | memory entries | 文件实际大小 |
|---|---|---|---|---|---|
| 日志3.log | 13:04:13.734 | 13:03:51.540 | 22.2s | 87 / 1000 | 131615 B |
| 日志4.log | 14:32:22.225 | 14:32:08.986 | 13.2s | 93 / 1000 | 176010 B |
| 日志5.log | 14:54:16.084 | 14:54:01.353 | 14.7s | 87 / 1000 | 52071 B |

三份日志的**第一行**都是 `[BOOT] app module loaded`（进程启动），**最后一行**都是启动流程末尾的
`[PLAYBACK] state ignored by guard state=Paused isTempId=true`。

→ 也就是说：**每一份日志都只覆盖"重启后的十几秒"**，而故障发生在导出之前的**上一个进程**里。
日志 5 尤其能说明问题：截图显示 14:53 界面还是空白（故障现场），14:54:01 才重启，14:54:16 导出——
导出内容与故障现场**没有任何交集**。

### 1.2 三份日志里都**没有**的东西（同样是证据）

- 没有任何 `ERROR`（`[FATAL]` / `[PLAYBACK_ERROR]` / `[STALL]` 一条都没有）；
- 没有任何后台时间线：没有 `[APP_STATE] app state changed: background`，也没有 `[HEARTBEAT]`；
- 没有 `[PLAYBACK] state state=Playing`（说明导出前还没开始播）。

这既不能证明"没崩溃"，也不能证明"没卡死"——只能证明**故障那一段根本没有被采集**。

### 1.3 两份"分享日志"没有带来新证据

`分享日志.log` / `分享日志2.log` 与 `日志5.log` / `日志4.log` **逐字节相同**（SHA256 一致）。
两份文件里仍然带着 `===== lx runtime log diagnostics =====` 这个**内存快照专属**表头，
说明它们并不是「分享日志」按钮（`readLogFile()` 读落盘文件）产出的内容。

---

## 二、为什么日志会变成这样：三处采集缺陷（已定位到代码）

### 缺陷 A：导出只含"当前进程内存缓冲"，不含落盘文件

- `src/utils/runtimeLog.ts` 的 `exportDiagnostics()` 只用 `state.entries`（内存环形缓冲）；
- `src/screens/Home/Views/Setting/settings/Other/Log.tsx` 的「复制诊断信息」正是调用它
  （旧的 `handleCopyDiagnostics` → `getDiagnostics()` → `exportDiagnostics()`）。
- 而 `state.entries` 是**进程内**数组，`init()` 从不会把文件内容读回内存。

→ 用户按上一版指南的建议"先杀掉应用重开再导出"，导出的就必然是**重开之后**的日志。
上一版指南里写着"重启后的日志里会保留上一次启动失败的原因"——**当时这个承诺在代码里并不存在**（现已实现）。

### 缺陷 B：后台期间 flush 定时器根本不触发（这是最致命的一条）

- `runtimeLog` 的批量落盘由 `setTimeout` 调度（`flushInterval = 2000ms`）；
- 但 RN 在应用退到后台时会**暂停全部 JS 定时器**：
  `ReactAndroid .../JavaTimerManager.java` 的 `onHostPause()` → `isPaused = true`，
  `setTimeout/setInterval/requestAnimationFrame` 在后台**一次都不触发**。

→ 后台播放期间产生的日志只会停在内存里，直到某次**显式 flush** 才可能落盘。
`src/app.ts` 的 AppState 监听只有"退到后台那一刻"会 `await flush()`，
所以落盘文件的结尾通常正好停在 `app state changed: background` 那一行——
**故障窗口在文件里也是一片空白**。进程被系统杀掉时，内存里那些日志一并消失。

> 这也解释了 `approx file size: 52071`：文件里确实有 52KB 历史（来自更早的多次启动），
> 但真正需要的那一段既没落盘、也没被导出。

### 缺陷 C：现有"看门狗"既看不到后台、也无法上报永久卡死，还会造假警报

- `src/utils/stallWatchdog.ts` 用普通 `setInterval(5000)`：后台不触发；
- 它只在"**恢复之后的那一跳**"里回看 gap（`handleTick` 里 `elapsed > stallThreshold` 才报），
  因此 **JS 线程永久卡死时它一条都不会输出**；
- 反过来，每次后台超过 20s 后回到前台，它都会写一条 `ERROR [STALL] JS thread blocked for <整段后台时长>ms`
  ——**假警报**，会把真信号淹没。

### 缺陷 D：故障现场相关的关键路径几乎不记日志

- 后台播放期间**没有任何周期性记录**（进度轮询成功路径完全无声：`store/player/action.ts` 的
  `playProgressChanged` 无日志）；
- `RENDER`（React 树是否还在更新）**零日志**：`src/screens/**` 下没有任何结构化日志；
- 音频焦点丢失（RemoteDuck）**被整段注释**（`plugins/player/service.ts`）；
- "取链接闩锁" `global.lx.gettingUrlId` 存在期间，`PlaybackState` 事件全部被丢弃
  （`service.ts` 的 guard），但那条日志**不带闩锁年龄**；
- 原生侧完全没有日志：`MusicService/MusicManager`（RNTP fork）没有静态入口，App 侧
  `MainApplication/MainActivity` 是空壳，`onTrimMemory/onLowMemory` 全仓零命中，
  也没有任何原生文件日志。**JS 一旦死掉，原生侧发生的一切都没有记录。**

---

## 三、结合现象与设置的假设排序（以及本次新增的判别证据）

截图（14:53）显示：通知栏仍是媒体通知，界面全白，顶部还有一行绿色悬浮歌词。
这条现象组合（**原生还活着、RN 界面没了**）是本次埋点设计的核心判别目标。

| # | 假设 | 与现象是否吻合 | 新增的判别证据 |
|---|---|---|---|
| H1 | **JS 线程被永久阻塞**（某个 await 永不返回 / 同步长任务） | 无声+进度不动+切歌无效+界面空白，全部吻合 | `[HEARTBEAT]`（**原生定时器**驱动）：后台仍有 tick ⇒ JS 活着；tick 停止/出现巨大 gap ⇒ JS 被卡住或进程被冻结。原生侧另有 `JS_UNRESPONSIVE no JS ack for Xms`（JS 死后仍会写） |
| H2 | **JS 未捕获异常 → React 树被卸载**（全局无 ErrorBoundary） | 界面空白、原生悬浮歌词停在最后一帧、点击无响应 | 新增 `[RENDER]` 渲染存活日志 + 屏幕级 `ErrorBoundary`（会写 `[RENDER] react render error caught ...` 并落盘）；心跳仍在但 `[RENDER]` 停 ⇒ H2 |
| H3 | **Activity/root view 丢失**（RNN 未重建） | 切回前台白屏、原生侧仍活 | `[BOOT] Navigation.setRoot start/done/failed`（原来这两点之间零日志）+ 原生 `ACTIVITY onResume/onPause/onDestroy/onCreate` |
| H4 | **进程被系统冻结或杀掉**（Android 16 后台策略/内存压力；用户缓存设为 1024 MiB） | 声音停止+一切停摆；但"杀进程重开才恢复"更倾向被杀 | 原生 `NATIVE_GAP heartbeat gap Xms`（冻结/长阻塞）+ `TRIM onTrimMemory level=...` + `JS_UNRESPONSIVE`；重启后 `[SESSION] previous session did not end cleanly` |
| H5 | **原生播放器/音频管线卡住**（音频卸载 + hires FLAC 是已知高风险组合） | 无声但状态仍 Playing、position 不前进；音频焦点问题也会"突然无声" | `[PLAYBACK_SILENT] player reports playing but position is not advancing`（JS，后台可用）；原生 `SILENT_PLAYBACK state=PLAYING but no active audio playback for Xms`（**JS 死后仍会写**）；`[PLAYBACK] remote duck (audio focus changed)`（原来整段被注释） |
| H6 | **播放状态事件被"取链接闩锁"吞掉**（`gettingUrlId` 期间 guard 丢弃全部状态） | 无声+进度不动+切歌无效，吻合；但不解释白屏 | `state ignored by guard` 现在带 `gettingUrlIdAgeMs`；闩锁年龄持续增大即为证据 |

**最可能的两条**（需要下一份日志确认）：H5（音频卸载 + hires FLAC 在后台停摆，导致"状态在播但没声"）
与 H1/H2（JS 侧卡死/异常导致界面空白）。本次埋点对这两类都能给出直接证据。

> 用户可立刻做的一个对照实验（不改代码）：把设置 → 播放里的「**启用音频卸载**」关掉，
> 观察是否还会在后台复现。若关闭后不再复现，H5 是首要方向（该设置官方本身就有"部分设备会导致
> 播放异常"的提示）。

---

## 四、本次改动（让"下一次"一定能查出问题）

### 4.1 JS：日志基础设施（`src/utils/runtimeLog.ts`）

| 改动 | 作用（对应缺陷） |
|---|---|
| flush 调度改用 `react-native-background-timer`（取不到才回退 `setTimeout`） | **B**：后台期间日志真正落盘 |
| `warn/error` 直接 `void flush()`（不依赖定时器）；`doFlush` 结束时只要还有待写内容就继续调度 | **B**：关键事件 + 后台残留都不会滞留内存 |
| 新增会话标识 + `[SESSION] session start/end` 标记；`markCleanExit()` 在读盘启动时分析"上一次会话" | A/H4：能判断上一次是**非正常结束** |
| 启动时把**上一次会话的尾部**注入本次内存缓冲（`[PREV_SESSION_RAW]`） | **A**：即使只点「复制诊断信息」也能看到故障那一次进程的日志 |

### 4.2 JS：新增后台心跳与静默检测（`src/utils/playbackHeartbeat.ts`）

- 用**原生定时器**每 30s 一跳（后台仍然触发），每跳显式 `flush()`；
- 每跳记录：`appState / isPlay / trackId / gettingUrlIdAgeMs / nowPlayTime / pollArmSeq / pollTickSeq / pollTickAgoMs / progressScreenOn`，
  并异步采样原生播放器 `state/position/duration/buffered/queueLen`；
- **心跳 gap** ⇒ `WARN [HEARTBEAT] heartbeat gap: JS thread was blocked or the process was frozen`（H1/H4）；
- **状态 Playing 但 position 不前进 ≥20s** ⇒ `ERROR [PLAYBACK_SILENT]`（H5，用户描述的直接对应）；
- **UI 认为在播、原生状态却不是 Playing** ⇒ `WARN [PLAYBACK_MISMATCH]`（H6）。

### 4.3 JS：看门狗不再造假警报（`src/utils/stallWatchdog.ts`）

新增 `noteAppState()`（由 `app.ts` 的 AppState 监听调用）：gap 若可由"后台暂停 JS 定时器"解释，
降级为 `INFO [WATCHDOG] timer gap explained by host pause ...`；只有前台真卡住才写 `ERROR [STALL]`，
并标注 `reason=js-blocked-foreground`。

### 4.4 JS：补齐关键路径埋点

| 文件 | 新增日志 |
|---|---|
| `plugins/player/service.ts` | guard 日志带 `gettingUrlIdAgeMs/isPlay/nowPlayTime/position`；**重新启用** `RemoteDuck`（音频焦点）日志并 flush |
| `core/player/player.ts` | `gettingUrlIdSince` 置位/清理 + `urlWaitMs`（取链接耗时） |
| `core/init/player/playProgress.ts` | 轮询 `started/stopped`（带原因与序号）、tick 计数、`getPosition` 长时间 pending 告警、屏幕状态镜像导出 |
| `core/init/player/player.ts` | `ui state -> playing/paused/stopped`、`playerEnded event -> playNext`（原为零日志） |
| `core/init/player/playInfo.ts` | 恢复播放的开始/跳过/完成（原为零日志） |
| `navigation/navigation.ts` | `Navigation.setRoot start/done/failed`（原空白段） |
| `store/player/hook.ts` | `[RENDER] progress rendered`（≥5s 节流）：证明 React 树仍在更新 |
| `utils/errorHandle.ts` | 崩溃上下文补 `appState/uiVisible/gettingUrlIdAgeMs/nowPlayTime`，并说明原生异常处理会"接管界面但不退进程" |
| `components/common/ErrorBoundary.tsx` + `navigation/registerScreens.tsx` | 每个屏幕加错误边界：捕获渲染异常 → `[RENDER]` 日志 + 落盘 + **可见的降级界面**（把"白屏"变成可操作的提示） |

### 4.5 JS：完整诊断导出（`src/utils/diagnostics.ts` + `nativeModules/diagnostics.ts`）

设置页的「分享日志」/「复制诊断信息」现在导出：
**即时状态**（原生播放器 state/position/duration/queue、播放器 store、相关设置、原生状态摘要）
+ **看门狗/心跳快照** + **当前进程内存缓冲（含上一次会话尾部）**
+ **落盘 `runtime.log` 全文（跨多次启动，尾部 12 万字符）**
+ **原生侧日志（尾部 6 万字符）**。

### 4.6 原生：独立于 JS 线程的证据链（`android/app/src/main/java/cn/toside/music/mobile/diagnostics/`）

新增 `DiagnosticsModule`（JS 侧 `NativeModules.DiagnosticsModule`）+ 自有日志文件
（`filesDir/diagnostics-native.log`，512KB 轮转），记录：

- **进程/环境启动信息**（版本、SDK、机型、largeHeap、maxMemory）；
- **Activity 生命周期**（onCreate/onResume/onPause/onStop/onDestroy）→ H3；
- **`onTrimMemory/onLowMemory`** → H4（内存压力）；
- **RNTP 事件广播**（`playback-state` / `playback-track-changed` / `playback-error` / `remote-duck` /
  `playback-queue-ended`）→ **JS 死掉也照样有播放时间线**；
- **原生心跳 gap**（自身 Handler 打点，间隔异常即"进程被冻结/looper 被阻塞"）→ H4；
- **JS 存活应答**：JS 每 10s `heartbeat()` 上报；超过 20s/60s 无应答写
  `JS_UNRESPONSIVE no JS ack for Xms` → **H1 在 JS 已经无法自救时仍可判定**；
- **音频是否真的在出声**：API≥26 用 `AudioManager.getActivePlaybackConfigurations()`；
  与最后收到的 `playback-state` 对比，若 state=PLAYING 而音频不活跃 >8s →
  `SILENT_PLAYBACK state=PLAYING but no active audio playback for Xms` → **H5 的原生版铁证**。

---

## 五、下一次复现时怎么读日志（判别流程）

1. 先看 `[SESSION] previous session did not end cleanly` → 确认故障那一次是不是**非正常结束**
   与其发生时间；紧接着展开 `[PREV_SESSION_RAW] ... end previous session tail` 区块（上次进程最后 80 行）。
2. 用时序重建时间线：`[APP_STATE] app state changed: background` → 之后的 `[HEARTBEAT] tick` 序列 →
   最后一条时间。
3. 分支判别：
   - `[HEARTBEAT]` 有 tick，且 `[RENDER] progress rendered` 也在持续 ⇒ JS/渲染都活着 → 看 `[PLAYBACK_SILENT]` / `SILENT_PLAYBACK`（H5）；
   - `[HEARTBEAT]` 有 tick，但 `[RENDER]` 停止 ⇒ **React 树已不再渲染**（H2/H3）；
   - `[HEARTBEAT]` 出现巨大 gap，原生侧同时 `NATIVE_GAP` ⇒ 进程被冻结或 JS 被长阻塞（H1/H4）；
   - 原生侧 `JS_UNRESPONSIVE` ⇒ JS 线程已死（H1）；
   - `[PLAYBACK] remote duck` ⇒ 音频焦点被系统/其它应用抢走（H5 的一个具体分支）；
   - `state ignored by guard` 且 `gettingUrlIdAgeMs` 持续增大 ⇒ 取链接闩锁吞掉全部状态（H6）；
   - 原生 `ACTIVITY onDestroy` 后没有 `onCreate`/`[BOOT] Navigation.setRoot done` ⇒ H3（root view 丢失）。
4. 关键 TAG 速查：`SESSION / PREV_SESSION_RAW / HEARTBEAT / PLAYBACK_SILENT / PLAYBACK_MISMATCH /
   RENDER / PLAYBACK_ERROR / STALL / APP_STATE / WATCHDOG / ACTIVITY / TRIM / TP / JS_UNRESPONSIVE / SILENT_PLAYBACK`。

---

## 六、诚实声明：本次仍然没能给出唯一根因

- 手上这 3 份日志**在结构上不含故障窗口**（见第一节），因此任何"唯一根因"的说法都是猜测。
  本次交付的是：把 H1–H6 全部变成**可判别**的，并补上原生侧（JS 死后仍可取证）这条链路。
- 未在本机验证的部分：无法真机复现、无法运行 App；JS 侧经 `tsc` 与 `eslint` 校验，
  原生侧经 Gradle 编译校验（见下），但**运行时行为仍需一台真机验证**。
- 原生新增模块对运行时的影响被刻意压到最低：所有写盘都在独立后台线程、全部 try/catch；
  JS 侧所有调用都做了"模块不存在则降级"的保护；原生日志文件 512KB 轮转、单份保留。

---

## 七、本次验证结果与残余风险

详细记录见 `.diagnosis/verification-2026-10-15.md`，要点：

| 检查 | 结果 |
|---|---|
| `npm run tsc` | ✅ exit 0 |
| `npm run lint`（全仓） | ✅ exit 0 |
| `gradlew :app:compileDebugJavaWithJavac --offline` | ✅ `BUILD SUCCESSFUL`，exit 0，原生日志模块 class 已产出 |

实现过程中发现并修掉的两个"会自己制造问题"的坑，值得记录：

1. **`AudioPlaybackConfiguration.isActive()` 不在公开 SDK 里**（编译直接失败）。
   现改为反射 + 宽松回退，并在每条相关日志里同时输出 `musicActive=0|1`、
   `audioActiveReflect=0|1` —— 若某台设备上音频探针不可用，日志会**自证**（
   `musicActive=1` 而 `audioActive=0` 就说明是探针瞎了，而不是真的没声音），
   从而避免把 `SILENT_PLAYBACK` 误读成"确实没声音"。
2. **新增的"getPosition 长时间 pending 就跳过"若不加超时会自造故障**：
   一旦某个原生 promise 永不 settle，轮询会被永久跳过 —— 那就等于亲手复现了
   "进度条再也不动"。因此改为只在 15s 内跳过、之后允许重新发起（并保留一次 WARN 证据）。

仍有待真机确认的点（首台设备第一次复现时看这几处即可）：
`SILENT_PLAYBACK` 是否只在真无声时出现（对照行内 `musicActive=`）、
后台 `[HEARTBEAT]` 是否确实在后台持续产生、以及原生日志是否真的在杀进程后仍然留存。

---

## 八、追加修复：「点分享日志 → Critical Error Occured !」（用户反馈）

### 8.1 现象与判定

用户反馈：点「分享日志」后**立即**弹出 `Critical Error Occured !`，界面没了，必须杀进程重开；
"下午该功能还能用"。该字符串来自 `react-native-exception-handler` 的原生错误界面
（`node_modules/react-native-exception-handler/android/src/main/res/layout/default_error_screen.xml:23`
的 `android:text="Critical Error Occured !"`）——即**发生了一次未被捕获的原生异常**，
其全局处理器接管界面并 `finish()` 掉当前 Activity（`forceToQuit=false`，进程与前台服务仍然存活）。

### 8.2 根因（三段证据闭合）

1. `android/app/src/main/java/cn/toside/music/mobile/utils/UtilsModule.java` 的 `shareText`
   把**整段文本**塞进 `Intent.EXTRA_TEXT`，**没有大小检查、没有 try/catch**：
   `Objects.requireNonNull(reactContext.getCurrentActivity()).startActivity(Intent.createChooser(...))`。
2. 设置页旧实现的「分享日志」传的是 `readLogFile()` —— **主文件 + 2 个轮转备份，
   最大可达约 1.5MB**。而 Binder 事务有大小上限（约 1MB，实际更小），
   超限时 `startActivity` 抛异常；因为没有任何 catch，它变成"未捕获异常"。
3. "下午还能用"也由此解释：那会儿日志还小（你给的诊断里 `approx file size` 只有几十 KB），
   之后日志继续增长（512KB 轮转 + 2 个备份），越过了上限。

结论：这不是新引入的问题，而是**旧代码里潜伏的大小/异常处理缺陷**；
本次改动把「分享日志」的导出内容显著加长（跨会话 + 原生日志），一旦照旧走文本分享会更容易触发它，
因此必须一并修掉。

### 8.3 修复

| 位置 | 改动 |
|---|---|
| `UtilsModule.shareText` | 加 `MAX_SHARE_TEXT_CHARS = 80000` 上限 + 整段 try/catch；超限或失败只记日志（含 `DiagnosticsLog`），绝不外泄成未捕获异常 |
| `UtilsModule.shareFile`（新） | `EXTRA_STREAM` + `FileProvider.getUriForFile(packageName + ".provider", file)` + `FLAG_GRANT_READ_URI_PERMISSION`，**文件不经过 Binder，无大小限制**；返回 `Promise`，失败 reject 而非崩溃 |
| `UtilsModule.startChooser`（新） | 统一 chooser 启动；Activity 不可用时退回 `ApplicationContext + FLAG_ACTIVITY_NEW_TASK` |
| `src/utils/nativeModules/utils.ts` | 新增 `shareFile(...)` 封装 |
| `src/utils/diagnostics.ts` | 新增 `writeFullDiagnosticsToFile()`（写入 CacheDir，FileProvider 已声明 `cache-path`）、`clipboardBudget`、`clipText/tailClip`、`maxClipboardChars` |
| `src/screens/.../Log.tsx` | 「分享日志」改为**生成文件后以文件分享**（失败才退化为受限文本）；「复制诊断信息」改用精简预算 + 60k 字符硬上限 + try/catch；「查看运行时日志」弹窗按 20 万字符裁剪显示，避免渲染 1.5MB 文本 |

> 旧版本用户注意：**在安装新版本之前不要点「分享日志」**（会触发上述崩溃）；
> 需要日志时点「查看运行时日志」（弹窗，不涉及 Intent）或「复制诊断信息」。

