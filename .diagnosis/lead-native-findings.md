# Lead 原生侧独立排查发现（关键根因线索）

排查对象：`lx-music-mobile`（React Native 0.73.11 / Hermes / newArch=OFF / targetSdk 见 gradle）
用户症状：**长时间听歌后挂掉** → (a) 歌曲不播放 (b) 应用打开后空白不显示；**玩游戏时更容易复现**。

> 说明：本条由 Lead 独立复核原生层得出，与队友 recon 的 JS 侧证据链互补。

## ~~F1【高】Manifest 缺少前台服务与 WakeLock~~ —— ❌ 已被推翻（保留作为纠错记录）

**初次结论（错误）**：我在 `android/app/src/main/AndroidManifest.xml` 里 grep 不到 `FOREGROUND_SERVICE` / `WAKE_LOCK` / `<service>`，判定前台服务缺失。

**推翻依据**：`android/app/src/main/AndroidManifest.xml` 里没有，**不代表合并后的 Manifest 里没有**。Android 构建会把依赖库的 Manifest 合并进来。实测：
- `node_modules/react-native-track-player/android/src/main/AndroidManifest.xml:5-6` **声明了** `WAKE_LOCK` 与 `FOREGROUND_SERVICE` 权限；
- 同文件 `:11-15` **声明了** `.service.MusicService`（含 `MEDIA_BUTTON` intent-filter）；
- 同文件 `:18-22` 声明了 `MediaButtonReceiver`。
- 原生实现确实调用前台服务：`.../service/MusicService.java:78`、`:119` 与 `.../metadata/MetadataManager.java:381` 均调用 `startForeground(1, ...)`。
- `android/build.gradle:8` `targetSdkVersion = 29` —— 低于 Android 14(API 34)，因此**不强制要求** `android:foregroundServiceType`。

**结论：F1 不成立。** 前台服务与 WakeLock 权限是齐备的，我最初的判断是**错误的**（原因：只看 app 模块 Manifest，忽略了 Manifest merge）。
**教训**：排查 Android Manifest 必须看**合并产物** `android/app/build/intermediates/merged_manifests/`，而不是只读 `src/main/AndroidManifest.xml`。

→ 因此"后台被冻结/杀死"这一假设**失去了一条主要支撑**，但不完全排除（前台服务在低内存时仍可能被系统回收，只是不是"缺声明"这种硬缺陷）。后续应以**本次新增的日志证据**为准来验证。

## F2【中】缺少 `largeHeap`，也没有任何内存压力回调

证据：
- grep `largeHeap|onTrimMemory|onLowMemory` → **No matches found**。
- `android/app/src/main/AndroidManifest.xml:15-24` 的 `<application>` 标签未设置 `android:largeHeap="true"`。
- `android/app/src/main/java/cn/toside/music/mobile/MainApplication.java:62-71` 的 `onCreate` 只做了 NewArch 加载与 Flipper 初始化，**没有覆写 `onTrimMemory` / `onLowMemory`**。

影响分析：
- 堆上限按默认比例，长时间播放 + 歌词解析 + 图片 + 无上限日志会让堆持续增长（见 F3）。
- 系统发出 `onTrimMemory(TRIM_MEMORY_RUNNING_LOW/CRITICAL)` 时，App **完全感知不到**，无法主动释放缓存（播放器缓冲区、图片、歌词）自救。
- 这使「长时间」这个时间维度成为必然的累积过程，符合用户描述。

## F3【中】日志文件无上限增长 —— 既是隐患也是「查不出问题」的原因

证据：
- `src/utils/log.ts:4` `logPath = temporaryDirectoryPath + '/error.log'`
- `src/utils/log.ts:8-11` `writeLog` 直接 `void appendFile(logPath, ...)`，**无大小检查、无轮转、无清理**。
- `src/utils/log.ts:29-35` `getLogs/clearLogs` 只能全量读/全删。

影响分析：
- 播放器长时间运行、每次错误都 append，文件可持续膨胀；CacheDir 写满可能反过来导致播放缓存（`maxCacheSize`，见 `src/plugins/player/index.ts:31`）无法写入 → URL/缓冲失败 → **声音停住**。
- 更关键：现有日志**只有 error 级别**，且写入是 fire-and-forget 异步。进程被系统杀死时，缓冲区里未 flush 的内容全部丢失 —— 这正是用户所说「无法排查」的机制性原因。

## F4【低-中】启动链路缺少超时兜底（白屏可诊断性）

证据：
- `src/app.ts:29-47` `handleInit`：`await import('@/core/init')` 与 `await init()` 串联，**无超时**。
- `src/app.ts:50-67` `initNavigation` 回调里 `await handleInit()` 后才 `pushHomeScreen()`；`handleInit` 一旦永不 resolve，就永远不 push 首页。
- `src/app.ts:46` `isInited ||= true` 在 `init()` 成功后才置位，失败路径直接 `exitApp()`。

影响分析：
- 「应用打开后空白」= `pushHomeScreen()` 未被调用或首页数据未就绪；当前**没有任何日志**能告诉用户卡在哪一步（`bootLog` 只在启动 catch 弹窗里展示）。

## 结论与建议优先级

| 优先级 | 措施 | 对应证据 |
| 优先级 | 措施 | 对应证据 | 状态 |
|---|---|---|---|
| — | ~~补齐前台服务 + FOREGROUND_SERVICE/WAKE_LOCK 权限~~ | ~~F1~~ | ❌ **已推翻**，勿采纳 |
| P0 | 交付的运行时日志（可落盘、带播放上下文、崩溃前 flush、可白屏查看）——用于把假设收敛为结论 | F3/F4 | 本次交付 |
| P1 | 加 `android:largeHeap="true"`，并在 MainApplication 覆写 `onTrimMemory` 上报日志 + 释放缓存 | F2 | 建议（未实施） |
| P1 | 启动链路加超时看门狗与阶段日志 | F4 | 本次交付（T4） |
| P2 | 补 `android:foregroundServiceType`（见 F1b）+ `MusicService.onCreate` 的 `startForeground` try/catch | F1b | 建议（未实施） |

> 注意：P1/P2 的原生改动属于**行为变更**，本次任务范围内**不实施**，只作为排查结论与后续建议输出；本次交付聚焦「加日志辅助排查」。

## F1b【中】前台服务虽已声明，但存在 3 个真实脆弱点（由 recon 独立发现，我复核后采纳）

F1 被推翻后，recon 做了更细的核查，发现前台服务**声明齐备但实现有洞**（这些是我漏掉的，我复核后确认成立）：

1. **`android:foregroundServiceType` 缺失**：`android/app/src/main/AndroidManifest.xml:11` 与合并后 manifest 的 `137-140` 均无该属性。
   —— 注意：`android/build.gradle:8` `targetSdkVersion = 29` < API 34，所以**当前不会因此崩溃**；但一旦将来提升 targetSdk 到 34+，Android 14 会要求它，届时前台服务**无法启动** → 后台播放直接失效。属**潜伏缺陷**。
2. **`MusicService.java:115-120` 在 `onCreate()` 里无条件 `startForeground(...)`，无 try/catch**：Android 13+ 若通知权限（`POST_NOTIFICATIONS`）未授予，该调用可能抛异常 → **服务创建失败** → 播放无声且无任何日志。
3. **`START_NOT_STICKY`（`MusicService.java:105,112`）**：进程被系统杀死后**不会重建**服务。这与用户"挂着后歌曲不播放、重开才好"的现象**高度吻合**。

另外：`MusicService.java` 依赖 `ExoPlayer.setWakeMode(WAKE_MODE_NONE)`（`MusicManager.java:143`），即**不持有 WakeLock 播放** —— 设备休眠/CPU 降频时音频线程可能被挂起。`WAKE_LOCK` 权限虽声明（库 manifest），但实际未使用。

→ 这 3 点强化了"长时间/后台被系统回收"这一方向，但**仍属推断**，需要本次新增的日志证据来确认。
