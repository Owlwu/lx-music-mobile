# 移动版「长时间听歌后挂掉 / 应用打开空白」证据链（task-1 / recon）

- 仓库：`E:\WorkSpace\LXMusic\lx-music-mobile`（lx-music-mobile v1.9.1，versionCode 78）
- 角色：只读排查分析师（recon）。本文档为唯一写入产物。
- 约束遵守：未修改任何 `src/**` 或 `android/**` 文件；未运行 gradle/构建。
- 运行环境限制：本会话的 `pwsh` 与 `glob` 工具对该仓库子树全部不可用（`sandbox-local windows-acl temp grant materialization failed`），因此**以下结论全部来自 `read`/`grep` 静态阅读，无运行时验证**。凡标注「未验证」的推断已明确区分。

---

## 0. 结论速览（TL;DR）

| # | 结论 | 置信度 |
|---|---|---|
| C1 | 播放错误路径只有一句 `console.log`，**没有任何持久化日志**；`PlaybackError` 的处理函数甚至没有区分错误类型 | 高（代码直读） |
| C2 | 前台服务声明**存在但不合规**：`targetSdkVersion 29`，`MusicService` 没有 `android:foregroundServiceType="mediaPlayback"`；且 `MusicService.onCreate()` 在 `POST_NOTIFICATIONS`（Android 13+）未授予时会抛异常，**可能直接导致服务创建失败/后台被杀** | 高（manifest+Java 直读）；未在真机验证 |
| C3 | 「空白」的根因候选是**初始化 Promise 无超时 + 失败即弹窗/退出**，其中 `initPlayInfo()` 会 `await playList()` → `await handlePlay()`，而 `handlePlay()` 内部含无超时的网络 await；`initNavigation` 的 callback 也会 `await handleInit()` | 高 |
| C4 | 存在多处**无上限内存增长**：`playedList`（按列表累积且随机模式不清理）、`playList.ts` 的模块级 `list[]`（只 `splice(0, len-2)`，但 `initTrackInfo` 只 push 不裁剪）、`log.ts` 的 `error.log` 无限 append、`plugins/lyric.ts` 的 `playHooks/setLyricHooks` 数组 | 高 |
| C5 | 现有 `error.log` 为什么排查不了：写入 `CacheDir`（用户/设置页难以取到）、**崩溃路径不落盘**（`log.error` 是 `void appendFile` 异步且无 flush）、**无上限**、且只有 error 级、无播放上下文（无状态机/无进度/无内存水位） | 高 |

---

## Q1. 哪些播放状态变化路径没有日志？

**答：几乎全部。整个播放状态机只有 1 处写日志，且是 `console.log`（不进 `error.log`）。**

证据：

1. `src/plugins/player/service.ts:79-112` —— `TPEvent.PlaybackState` 监听器。`switch (info.state)` 分支（`None/Ready/Stopped/Paused/Playing/Buffering/Connecting`）**全部只发 `global.app_event.*`，没有任何 log 调用**；`default` 分支第 105 行是被注释掉的 `console.log('playback-state', info)`。
2. `src/plugins/player/service.ts:69-73` —— `PlaybackError` 唯一落点：
   ```ts
   TrackPlayer.addEventListener(TPEvent.PlaybackError, async(err: any) => {
     console.log('playback-error', err)          // ← 仅 console，不进文件
     global.app_event.error()
     global.app_event.playerError()
   })
   ```
   **没有 err.code / err.message / 当前 track / 当前 url / 网络状态 / 时间戳**，也没有写入 `@/utils/log`。这正是「歌曲不播」时查不到原因的核心缺口。
3. `src/plugins/player/service.ts:113-176` —— `TPEvent.PlaybackTrackChanged` 监听器。切歌关键路径（`getCurrentTrackId()`、`isEmpty()` 后的临时暂停、`playerEnded/playerEmptied`）**全部无日志**；第 114 行 `// console.log('PlaybackTrackChanged====>', info)` 被注释。
4. `src/plugins/player/service.ts:27-31, 205-213` —— 服务注册入口只有 `console.log('reg services...')` / `console.log('handle registerPlaybackService...')`：能证明「注册过」，但**无法证明服务在事故时刻还活着**，也没有重复注册/未注册的检测。
5. URL 刷新路径无日志：
   - `src/core/player/player.ts:136-155` `setMusicUrl()`：只有 `catch` 里 `console.log(err)`（第 145 行）；`then` 成功分支**完全无日志**。
   - `src/core/player/player.ts:97-134` `getMusicPlayUrl()`：重试/换源/`delayRetry` 全链路无日志。
   - `src/core/init/player/playerEvent.ts:16-41` `startLoadingTimeout()`：25s 加载超时后决定「刷新 URL」还是 `playNext(true)`，**两条分支都没有日志**，只在第 112 行 `console.warn('error skip to next')` 有一句非持久化告警。
6. 自动切歌无日志：`src/core/init/player/player.ts:20-32` `handleEnded` → `void playNext(true)`；`src/core/player/player.ts:415-509` `playNext()` 整个函数无日志（仅 `src/core/player/player.ts:50` 一句 `console.log('delay next timeout timeout', delay)`）。
7. 缓冲/等待无日志：`src/core/init/player/playerEvent.ts:80-87` `handleEmpied`/`handleWating` 只 `setStatusText`，无日志。`src/plugins/player/utils.ts:209-242` `onStateChange()` 把 TP 状态映射为字符串后交给 UI，**没有任何订阅方写日志**（需确认调用方，见 Q4 埋点建议）。
8. `src/plugins/player/index.ts:4-17`：一段**被整块注释掉的**事件监听（`playback-error`/`playback-state`/`playback-track-changed`/`playback-queue-ended` 全部 `console.log`）。作者曾有过这层观测，后来注释掉且没补上等价的文件日志。
9. `src/plugins/player/index.ts:19-44` `initial()`：`setupPlayer(...)`、`updateOptions()`、`setVolume()`、`setPlaybackRate()` **全部无 try/catch、无日志**；一旦 `setupPlayer` 抛错（例如 maxCacheSize 异常、服务被系统拒绝），只有未捕获的 Promise rejection，而 `handleInit` 的 `catch`（`src/app.ts:35-45`）会弹「初始化失败」并退出——**这条路径不写 error.log**。

**Q1 缺口清单（按优先级）**：PlaybackError 详情 → PlaybackState 全部迁移 → PlaybackTrackChanged → URL 刷新/重试/换源 → 25s 加载超时分支 → 自动切歌 → setupPlayer 失败。

---

## Q2. 「歌曲不播放」最可能卡在哪几个 await / 无超时点上？

**答：播放入口 `handlePlay()` 有一段「先 await setStop()，再 debounce 网络取 URL」的链路；其中 `await setStop()`（无超时）和 `handlePlayNext` 的 await 链最可能卡死。另外 25s 加载超时定时器依赖 `BackgroundTimer`，在 JS 线程饥饿或原生定时器停摆时不保证触发。**

### Q2-a 明确「无超时」的 await（按风险排序）

| 风险 | 位置 | 说明 |
|---|---|---|
| ★★★ | `src/core/player/player.ts:260` `await setStop()` | → `src/plugins/player/utils.ts:160-163` `TrackPlayer.stop()` + `skipToNext()`。**纯原生 Promise，无超时**。若 native player 处于坏状态（解码器卡死、audio offload 异常），此 await 永不 resolve，`handlePlay()` 后续（取 URL、播放）**全部不会执行**，UI 表现就是「点了播放/切歌但歌不播」。 |
| ★★★ | `src/core/player/player.ts:285, 299, 408, 419, 455, 460, 504, 545, 591` `await handlePlay()` / `await handlePlayNext()` | 均直接 await 上面的 `handlePlay()`，无任何超时包装；`playNext()`（415-509）本身也被 `service.ts` 的 `PlaybackTrackChanged`/`RemoteNext` 以及 5s `addDelayNextTimeout` 调用，**一处卡住会导致整条自动切歌链停摆**。 |
| ★★★ | `src/plugins/player/playList.ts:155-159` | `await TrackPlayer.getCurrentTrack()` → `await TrackPlayer.add(tracks)` → `await TrackPlayer.getQueue()` → `await TrackPlayer.skip(...)`。**四个连续原生 await，无超时**。任何一步不返回即静默死锁，且**这段代码没有 try/catch**（`playMusic()` 里是 `void playPromise.finally(...)`，见第 190-193 行，**rejection 被 `.finally` 吞掉，没有 `.catch`**）。 |
| ★★★ | `src/plugins/player/playList.ts:186-194` `playMusic()` | `void playPromise.finally(() => { playPromise = handlePlayMusic(...) })`。若 `handlePlayMusic` reject，`.finally` 不处理 rejection → 产生**未处理的 Promise rejection**（Hermes 下可能只打 console；`errorHandle.ts` 的 handler 只在 fatal 时弹窗，`log.error` 在 `src/utils/errorHandle.ts:32`），且 `handlePlayMusic` 的失败**不会触发任何重试或状态回退**。 |
| ★★ | `src/plugins/player/utils.ts:109-151` `playMusic` debounce 包装器 | 内部 `fn(musicInfo, url, time)` 是 `handlePlayMusic`（`src/plugins/player/utils.ts:149-151`），同上无 catch。注意 800ms 防抖 + `BackgroundTimer.setTimeout` 依赖 JS 定时器。 |
| ★★ | `src/core/init/player/playProgress.ts:41-42` `getMaxTime()` | `setMaxplayTime(await getDuration())`，`getDuration` = `TrackPlayer.getDuration()`（`src/plugins/player/utils.ts:159`），**无超时**。由 `handlePlay`（第 85-90 行）在每次播放时 `void getMaxTime()` 调用。 |
| ★★ | `src/core/init/player/playProgress.ts:31-39` `getCurrentTime()` | `getPosition().then(...)`，1s 间隔轮询（第 67-69 行 `BackgroundTimer.setInterval`）。同样是无超时原生 Promise，但 `.then` 未 catch，失败会静默。 |
| ★★ | `src/plugins/player/playList.ts:113-120` `getCurrentTrackId()` / `getCurrentTrack()` | `await TrackPlayer.getCurrentTrack()`，被 `service.ts:115`（TrackChanged 回调）、`updateMetaData`（122-139）、`initTrackInfo`（141-147）调用，**无超时**。 |
| ★★ | `src/plugins/player/utils.ts:184-186, 201-205` | `isCached` / `getCacheSize` / `clearCache` / `destroy` = 直接透传原生 Promise，**无超时**；`destroy()`（201-205）在 `exitApp` 路径（`src/core/common.ts:53-65`）被 await。 |
| ★ | `src/utils/nativeModules/utils.ts:32-45, 88-101` | `requestNotificationPermission` / `requestIgnoreBatteryOptimization`：等待 `AppState` 变为 `active` 才 resolve。若用户不返回应用（例如跳转系统设置后进程被杀），**Promise 永不 resolve**。`checkNotificationPermission()`（`src/utils/tools.ts:244-283`）直接 `await isNotificationsEnabled()` 且无 catch。这两者都在 `handlePlay()` 的最前面（`src/core/player/player.ts:231-233`），**首次播放时会先 await 它们**。 |

### Q2-b 网络/IO 侧的 await（**有**部分超时，但超时机制本身有前提）

- `src/utils/request.js:169-217` `fetchData()`：`timeout = 15000` 默认，`AbortController` + `BackgroundTimer.setTimeout` 实现。**这是唯一成体系的超时**。注意：
  - 第 173-176 行：超时定时器用的是 `BackgroundTimer`，**不是 `setTimeout`**。若原生定时器模块（`react-native-background-timer` 的 `Timers`）在长时间后台运行中被系统回收，超时不会触发，`fetch` 就无限挂起。
  - 第 148-153 行 `return {...options, method, headers}` —— `...options` 在第 104 行已经解构掉 `timeout`，所以传给 `fetch` 的没有 timeout 字段，**超时完全依赖那个原生定时器**。
- `src/core/music/utils.ts:55-76` `getOtherSource()`：`BackgroundTimer.setTimeout(..., 12_000)` → `reject(new Error('find music timeout'))`。同理依赖原生定时器。
- `src/core/init/userApi/index.ts:52-58`：用户自定义 API 请求 20s 超时，同理。
- **无超时**的网络/IO await（补齐 Q2）：
  - `src/core/music/utils.ts:159, 182, 202, 244, 298` `if (!await global.lx.apiInitPromise[0])` —— 若自定义 API 脚本 init 既不成功也不失败，**这里永久挂起**（`apiInitPromise` 初值 `[Promise.resolve(false), true, () => {}]`，见 `src/config/globalData.ts:56`）。
  - `src/core/init/player/player.ts:76-96` `delayRetry()`：`setTimeout`（JS 定时器，非 BackgroundTimer）+ `getMusicPlayUrl` 递归重试，**递归深度受 `isRetryed` 限制，但整体无总超时**。
  - `src/core/music/utils.ts:249-259, 273-281, 315-328` 换源遍历：`while` 循环 + 递归调用，**无总超时**，只受源数量限制。
  - `src/core/music/online.ts:56` `await getStoreMusicUrl(...)`、`src/core/music/online.ts:99-100` `saveLyric` → `src/plugins/storage.ts:46-58` `AsyncStorage.multiSet`：**无超时**。
  - `src/plugins/player/utils.ts:187-199` `migratePlayerCache()`：`moveFile`（`src/utils/fs.ts:54` `FileSystem.mv`）**无超时**，且在 `setupPlayer` **之前**被 await（`src/plugins/player/index.ts:29-30`），大缓存迁移会阻塞初始化。

### Q2-c 定时器体系（为什么"玩游戏时更容易"）

- 全仓的关键定时器都走 `react-native-background-timer`：`src/plugins/player/utils.ts:2`、`src/plugins/player/playList.ts:2`、`src/core/player/player.ts:26`、`src/core/init/player/playProgress.ts:7`、`src/core/init/player/playerEvent.ts:5`、`src/core/init/player/preloadNextMusic.ts`（间接）。
- `src/core/init/player/preloadNextMusic.ts:18-36` `preloadNextMusicUrl()`：`preloadMusicInfo.isLoading` 是**布尔锁，没有超时释放**。第 20 行置 `true`，第 35 行才置 `false`；若中间任一 await（`getNextPlayMusicInfo()` → `filterList`、`getMusicUrl`、`isCached`、`checkUrl`）卡住或抛错，**`isLoading` 永远停在 `true`，预加载从此永久失效**（这是"长时间听歌后体验劣化"的一个真实机制）。
- `src/core/init/player/playProgress.ts:64-71` `startUpdateTimeout()`：`BackgroundTimer.setInterval(..., 1000 / playbackRate)`。第 155-160 行 `handleScreenStateChanged` 会在熄屏时 `clearUpdateTimeout()`，第 163-165 行用 `AppState` 兜底补一次 `onScreenStateChanged('ON')`。**若 `screen-state` 事件在息屏/游戏抢前台时丢失且 AppState 未回 active，进度更新会永久停止**——此时歌可能还在响，但 UI/进度全停，用户感知接近"挂了"。

---

## Q3. 「应用打开后空白」：首页渲染依赖哪些初始化 Promise？哪些没有超时/失败兜底？

### Q3-a 启动链路（`src/app.ts`）

```
src/app.ts:11-12   console.log('starting app...') → listenLaunchEvent()   ← 无日志文件
src/app.ts:14      await Promise.all([getFontSize(), windowSizeTools.init()])
src/app.ts:48      await import('@/navigation')
src/app.ts:50-67   initNavigation(async () => { await handleInit(); ... await navigations.pushHomeScreen() })
src/app.ts:29-47   handleInit(): await import('@/core/init') → await init()
```

关键证据：

1. **`src/app.ts:50-51`：`initNavigation(async() => { await handleInit() ... })`** —— `handleInit()` 在**放到 root 之前**被 await。而 `src/core/init/index.ts:34-71` 的 `init()` 是一整串串行 await（第 39/43/45/48/56/58/60 行），**其中任何一步永不 resolve，`pushHomeScreen()` 就永不执行 → 屏幕全空白**。这是「空白」最强的结构性解释。
2. **`src/app.ts:31` `void initLog()`** —— `initLog` 是 `void` 调用，**不 await**。而日志文件路径（`src/utils/log.ts:4`）是 `temporaryDirectoryPath + '/error.log'`。在 `initLog()` 完成前发生的任何日志，走的是 `logTools.tempLog` 内存数组（`src/utils/log.ts:7, 43-44, 51-52, 58-59`）；**如果进程在 `initLogFile()` 完成前被杀，这些日志全部丢失**。
3. **失败兜底是「弹窗 + exitApp」而不是「降级进首页」**：
   - `src/app.ts:35-45`：`handleInit` 内 `init()` 抛错 → `tipDialog` → `exitApp()`。
   - `src/app.ts:57-66`：`pushHomeScreen()` 抛错 → `tipDialog('Error')` → `exitApp()`。
   - `src/app.ts:68-77`：外层 `.catch` → `tipDialog` → `exitApp()`。
   - 注意 `src/app.ts:36` 和 `src/app.ts:58`：`tipDialog` 本身是 `await` 的 `Alert.alert` Promise（`src/utils/tools.ts:216-237`）。**在 React Native 里如果 RootView 尚未 attach（正是"首页还没 push"的时刻），`Alert.alert` 可能根本不显示 → 用户看到的就是纯空白**，而且此时 `log.error` 也不会被调用（这条路径没有任何 `@/utils/log` 写入）。
4. **没有任何超时**：`src/app.ts` 全文（77 行）没有一处 `setTimeout`/超时竞速。`Promise.all([getFontSize(), windowSizeTools.init()])`（第 14 行）—— `windowSizeTools.init()`（`src/utils/windowSizeTools.ts:31-56`）会 await `getWindowSize()`，即原生 `UtilsModule.getWindowSize()`（`src/utils/nativeModules/utils.ts:67-69`），**无超时**。

### Q3-b `src/core/init/index.ts` 的串行 await 及各自兜底

| 行 | 调用 | 兜底 | 超时 |
|---|---|---|---|
| 39 | `await initSetting()` → `src/core/init/index.ts` → `src/core/common.ts:28-32` → `initAppSetting()` → AsyncStorage | 无 try/catch | 无 |
| 43 | `await initTheme(setting)` → `src/core/init/theme.ts:10-38`（`applyTheme(await getTheme())`） | 无 | 无 |
| 45 | `await initI18n(setting)` → `src/core/init/i18n.ts:7-22`，含 `await getDeviceLanguage()`（原生） | 无 | 无 |
| 48 | `await initUserApi(setting)` → `src/core/init/userApi/index.ts:10-256`，含 `await getUserApiList()`（AsyncStorage） | 无 | 无 |
| 54 | `registerPlaybackService()`（同步） | 无 | — |
| 56 | `await initPlayer(setting)` → `src/core/init/player/index.ts:10-19` → **`await initPlayer(setting)` / `await initLyric` / `await initPlayInfo`** | 无 | 无 |
| 58 | `await dataInit(setting)` → `src/core/init/dataInit.ts:25-37` | 无 | 无 |
| 60 | `await initCommonState(setting)` | 无 | 无 |
| 63 | `void initSync(setting)` | 不 await（好） | — |

**Q3 未超时/未兜底的关键子项**：

- **`src/core/init/player/playInfo.ts:15` `await playList(info.listId, info.index)`** —— 这是最容易致命的一处：`playList()`（`src/core/player/player.ts:293-300`）→ `await handlePlay()` → 第 260 行 `await setStop()` → 第 269 行 `debouncePlay(musicInfo)`。**即"恢复上次播放位置"会把全量播放初始化塞进启动路径**。若 `TrackPlayer` 尚未就绪或原生调用挂起，**首页永不出来**。
  - 进一步：`playInfo.ts:11` `await getListMusics(info.listId)`（AsyncStorage）；`playInfo.ts:17` `if (setting['player.startupAutoPlay']) setTimeout(play)`（`src/core/init/player/playInfo.ts:17`）——这是 JS 定时器，非 BackgroundTimer。
- **`src/core/init/player/player.ts:11-64`** 的 `initPlayer(setting)` 是 `async` 但函数体（第 12-63 行）**全是同步注册**，没有 await，所以它本身不是阻塞源——但也**没有任何日志说明各监听器是否注册成功**。
- **`src/core/init/player/lyric.ts:25-31`** `await initLyricPlayer()` + `await Promise.all([setPlaybackRate, toggleTranslation, toggleRoma])`：`initLyricPlayer` 对应 `src/core/lyric.ts:26-28` → `src/plugins/lyric.ts:66-68`，内部 `lrcTools.init()` 是同步的（第 21-29 行 `if (this.isInited) return`）。**风险在于 `lrcInit()` 是 async 但第 67 行只做同步构造；若 `lrcTools.lrc` 为 null，后续 `setPlaybackRate`（`src/plugins/lyric.ts:77-79` `lrcTools.lrc!.setPlaybackRate`）会抛 TypeError**，被 `index.ts:56` 的 await 链一路冒泡到 `src/app.ts:35` → 弹窗/退出（而用户看到的是空白）。
- **`src/core/init/dataInit.ts:31-34`**：`setUserList(await getUserLists())`、`setDislikeInfo(await getDislikeInfo())`、`setNavActiveId((await getViewPrevState()).id)` —— 三次 AsyncStorage 串行 await，**无 try/catch**。`getDislikeInfo` 还要解析规则（见 `src/core/dislikeList.ts`，未逐行读）。
- **`src/core/init/common.ts:28-70`** `initCommonState`：`handlePicUpdate()` → `prefetch(picUrl)`（`src/components/common/ImageBackground.tsx:98-100` `Image.prefetch`）——`void`，不 await（好）。
- **导航本身**：`src/navigation/index.ts:11-31` `init(callback)` 注册 `onAppLaunched`；`src/navigation/regLaunchedEvent.ts:7-24` 用 `setImmediate` 分发。也就是说：**`Navigation.events().registerAppLaunchedListener` 触发 → handleInit → pushHomeScreen**。若 `AppRegistry`/RNN 的 `appLaunched` 事件在冷启动竞态中丢失（`regLaunchedEvent.ts:3` 的 `launched` 标志没被置位，`onAppLaunched` 的回调也只在 `launched == true` 时 `setImmediate` 执行），**首页永远不会被 push，屏幕就是空白**。这里**完全没有超时或"若 3s 内未 launch 则强制 push"的兜底**。

### Q3-c 首页渲染依赖

- `src/screens/index.ts:1` 导出 `Home`；`src/screens/Home/Vertical/index.tsx:4-11` = `<Content />` + `<PlayerBar />`；`Content.tsx` → `Header` + `Main`。
- `src/screens/Home/Vertical/Main.tsx:196-284`：`Main` 用 `commonState.navActiveId` 决定 `initialPage`（第 198、269 行）。而 `navActiveId` 由 `src/core/init/dataInit.ts:34` 的 `setNavActiveId((await getViewPrevState()).id)` 设置 —— **如果 `dataInit` 卡住，`navActiveId` 是默认值（`src/config/constant.ts:152-155` `viewPrevState.id = 'nav_search'`），页面能渲染但内容是默认页；但如果 `dataInit` 卡住导致整个 `handleInit` 卡住，首页压根不会 push**。
- `Main.tsx:277-285` 各页用 `View collapsable={false}` 包 `PagerView`，`offscreenPageLimit={1}`（第 271 行）。

---

## Q4. 内存压力线索：无上限的数组 / Map / 缓存

| 位置 | 结构 | 是否有上限 | 证据 |
|---|---|---|---|
| `src/store/player/state.ts:24, 72` + `src/store/player/action.ts:67-72` | `playedList: LX.Player.PlayMusicInfo[]` | **仅按 `musicInfo.id` 去重**（`action.ts:68`），**无长度上限**。只在 `action.ts:78-82 clearPlayedList()` 清空；触发点：`src/core/player/player.ts:283, 297`（`isAutoCleanPlayedList` 或换列表时）、`src/core/player/utils.ts:127-128`（过滤后为空时） | 长时间**同一列表**循环听歌且 `player.isAutoCleanPlayedList=false` 时，`playedList` 会累积到整个列表长度；`random` 模式每次播放都 `addPlayedList`（`src/core/player/player.ts:196, 267`）。每条是完整 `MusicInfo`（含 `meta`、`qualitys`），**单条可含多个音质 URL**，规模可观。 |
| `src/core/player/player.ts:349-357, 444-452, 534-542` | 遍历 `playedList` 并对每项做 `currentList.some(...)` 线性查找 | **O(n·m)** | 列表大时，每次切歌的 `findIndex`/`some` 是 O(n·m)，**长时运行会持续占用 JS 线程**（配合 Q2 的定时器问题 → 加剧卡顿）。 |
| `src/plugins/player/playList.ts:9, 143, 156, 183` | 模块级 `const list: LX.Player.Track[]` | **仅 `splice(0, list.length - 2)`**（第 183 行，且包在 `if (queue.length > 2)` 里） | 第 143 行 `initTrackInfo` 只 `list.push(...tracks)` **不裁剪**；`tracks` 每首 2 条（`buildTracks` 第 50 与 64 行各 push 一条）。裁剪依赖 `TrackPlayer.remove` 成功（`void ... .then(...)`，**失败则 `list` 不裁剪**）。`list` 元素含 `url`/`artwork`/`lyric`（第 48、59 行 —— **`lyric` 是整首歌词全文**！），无上限增长会非常可观。 |
| `src/plugins/player/playList.ts:198, 214-215` + `src/plugins/player/utils.ts:214` | `prevArtwork: string` / `artwork` | 无上限（只存 1 个 URL，风险低） | 但 `TrackPlayer.updateNowPlayingMetadata`（第 225-232 行）每次传 `lyric: getCurrentFullLyric(...)`（第 231 行），**完整歌词通过 bridge 传输**，长歌词 + 高频调用 = 内存/CPU 抖动。 |
| `src/core/music/utils.ts:16, 18, 61` | `getOtherSourcePromises: Map` / `otherSourceCache: Map` | `otherSourceCache` **仅 `size > 10` 时 `clear()`**（第 61 行，粗暴全清）；`getOtherSourcePromises` 在 `.finally` 删除（第 71-73 行） | Cache 的 key 是 **`musicInfo` 对象本身**（第 18 行 `Map<LX.Music.MusicInfo \| LX.Download.ListItem, ...>`）——**用对象引用做 key 意味着同一首歌的不同对象版本会各占一条**，且 `clear()` 后引用才释放。缓存值 `LX.Music.MusicInfoOnline[]`（一整份其他源搜索结果）体积大。 |
| `src/core/init/player/preloadNextMusic.ts:8-12` | `preloadMusicInfo`（单对象） | 有（单值） | 但 `isLoading` 锁无超时（见 Q2-c），**不是内存问题而是功能永久失效**。 |
| `src/plugins/lyric.ts:13-14, 43-56` | `playHooks: PlayHook[]` / `setLyricHooks: SetLyricHook[]` | **无上限**；`removePlayHook`（第 47-49 行）用 `splice(this.playHooks.indexOf(hook), 1)` —— **若 `indexOf` 返回 -1，`splice(-1, 1)` 会删掉最后一个元素（错误元素）**，导致 hook 泄漏累积 | `addPlayHook`/`addSetLyricHook` 由 `useLrcPlay`/`useLrcSet`（第 102-136 行）在 `useEffect` 中注册/注销。**播放详情页反复进出**时，若某次注销失败（组件非正常卸载、indexOf -1），hook 数组只增不减；每个 hook 持有 `setLrcInfo`（闭包捕获 state），**旧组件无法 GC** → 长期听歌 + 频繁切页会持续泄漏。 |
| `src/utils/log.ts:4, 10` | `error.log` | **无上限**：`appendFile(logPath, '\n----lx log----\n' + msg)` **每次直接追加，无大小检查、无轮转、无清理** | 只有 `clearLogs()`（第 33-35 行）手动清。`logTools.tempLog`（第 7 行）在 init 前是**无界数组**。 |
| `src/utils/bootLog.ts:1, 4-6` | `logs: string[]` | **无上限，且永不清空**（纯内存，不落盘） | 第 5 行 `logs.push(...)` 无任何修剪；`getBootLog()` 每次拼接全量字符串。 |
| `src/plugins/storage.ts:9-25` | AsyncStorage 分片（`limit = 500000`） | 分片本身无上限 | `saveData`（46-58）先 `removeData` 再 `multiSet`，逻辑上不累积；但 `musicUrl`/`lyric` 缓存键（`src/utils/data.ts:352-360`）**随听过的歌无限增长**，无 TTL、无容量上限（只有设置页手动 `clearMusicUrl`/`clearLyric`，见 `src/utils/data.ts:354-364`）。 |
| `src/plugins/player/index.ts:31-35` | `maxCacheSize: cacheSize * 1024`, `maxBuffer: 1000` | 配置由设置决定 | `maxBuffer: 1000` 传给 `MusicManager.java:128` 的 `options.getDouble("maxBuffer", ...)` → `Utils.toMillis(...)`，即 **1000 秒 = ~16.7 分钟音频缓冲**（配合 `waitForBuffer: true` 第 33 行）。这是很大的常驻缓冲，**值得作为内存水位嫌疑点记录**（单位需按 fork 的 `Utils.toMillis` 语义复核，**未验证**）。 |
| `src/utils/windowSizeTools.ts:20, 24-30` | `listeners: SizeHandler[]` | 无上限 | `onSizeChanged` push，返回的注销函数需被调用方使用；未在启动链路中注册，风险低。 |

**Android 侧的 largeHeap / onTrimMemory**：
- `android/app/src/main/AndroidManifest.xml:15-24` 的 `<application>` **没有 `android:largeHeap="true"`**。
- 全仓 `grep onTrimMemory|onLowMemory` 在 `android/app/src/main/java/**` **零命中**（唯一命中是 `UtilsModule.java:177` 的 `screenkeepAwake`，属亮屏保持，不是内存回调）。→ **应用对系统内存压力没有任何主动响应（无降级、无日志）**。
- `android/app/build.gradle:161, 162, 69`：`minifyEnabled enableProguardInReleaseBuilds`（true）+ `proguardFiles ... "proguard-rules.pro"`。**混淆会影响崩溃栈可读性**（需 `mapping.txt` 才能还原），这也是"崩溃后查不到"的一个因素（**release 包**）。

---

## Q5. 现有 `error.log` 为什么排查不了？

**答：路径难取、崩溃时不落盘、无上限、只有 error 没有播放上下文——四条独立缺陷叠加。**

1. **写入路径在 CacheDir，用户和"设置-错误日志"都依赖应用内读取**
   - `src/utils/log.ts:4`：`const logPath = temporaryDirectoryPath + '/error.log'`。
   - `src/utils/fs.ts:20`：`temporaryDirectoryPath = Dirs.CacheDir`。
   - 后果：(a) **CacheDir 可被系统在存储紧张时清理**，事证可能消失；(b) 用户拿不到文件（非 root 无法直接访问 app 私有目录）；(c) 事故后重启应用若被清理，日志已丢失。
   - 读取入口只有 `getLogs()`（`src/utils/log.ts:29-31` → `readFile(logPath)`），只能由应用内 UI 展示。

2. **崩溃时不落盘 —— 写入是 fire-and-forget 异步，且没有 flush**
   - `src/utils/log.ts:8-11` `writeLog(msg) { console.log(msg); void appendFile(logPath, ...) }`：**`void` 前缀 = 不 await、不重试、无回调**。
   - `src/utils/log.ts:37-63` 的 `log.info/warn/error` 都只是 `logTools.writeLog(...)`（或 push 到 `tempLog`），**没有任何"立即同步落盘"的路径**。
   - 结果：**进程被系统杀死（OOM kill / LMK / 强停）时，已调用但未完成磁盘写的日志全部丢失**——而"玩游戏时更容易复现"正是典型的系统级杀进程场景。
   - 关联：`src/utils/errorHandle.ts:35-41` 只在 `process.env.NODE_ENV !== 'development'` 时注册；`setNativeExceptionHandler(..., false)` 的第二个参数 `false` = **不退出应用**。handler 里 `log.error(errorString)`（第 39 行）同样走 fire-and-forget 异步 append —— **native 崩溃/被 kill 的路径基本不落盘**。
   - `src/utils/errorHandle.ts:11-31`：只有 `isFatal` 才弹窗；**非 fatal 错误只 `log.error(e.stack)`（第 32 行）——同样是不落盘的异步写**。

3. **`error.log` 无上限增长**
   - `src/utils/log.ts:10`：纯 append，无 size 检查、无轮转、无截断；`initLogFile()`（12-22）只判断"文件是否存在"，**从不检查大小**。
   - 恶化机制：`src/utils/request.js:170` 每次请求都 `console.log('---start---', url)` → 高频；`src/core/init/player/preloadNextMusic.ts:21, 27, 31`、`src/core/player/player.ts:50, 145`、`src/core/music/utils.ts:256, 278, 311, 348, 367, 395, 431, 458, 491` 等大量 `console.log`。这些**不进 error.log**（只走 console），但说明**代码里到处是 console 而非结构化日志**：真正的问题发生时，`console.log` 的输出在 release 包中**默认不可见**（无 `adb logcat` 就拿不到），而 `error.log` 里什么都没有。
   - 于是形成"双向黑洞"：**console 有噪音没落盘，error.log 有落盘没内容**。

4. **只有 error 级、且完全没有播放上下文**
   - `src/utils/log.ts:37-63` 定义了 info/warn/error 三档，但**播放链路（Q1）一处都没用**。全仓调用 `log.*` 的位置（grep 结果）集中在：`src/plugins/storage.ts`（存储错误）、`src/plugins/sync/**`（同步）、`src/screens/Home/Views/Mylist/**`（列表）、`src/utils/localMediaMetadata.ts`（**扫描本地音乐**）、`src/utils/errorHandle.ts`。
   - **这正是用户说的"目前已有的日志是扫描歌曲的日志"**：`src/utils/localMediaMetadata.ts:67, 87` 是扫描路径写日志的地方，加上 `src/screens/Home/Views/Mylist/MyList/listAction.ts:184` 的 `Parse metadata failed` 和 `listAction.ts:27, 52, 68, 76`。**播放器模块（`src/plugins/player/**`、`src/core/player/**`、`src/core/init/player/**`）零 `log.*` 调用**。
   - 缺的字段至少包括：时间戳、进程/会话 id、`PlaybackState` 迁移前后值、当前 `trackId`/`musicInfo.id`、`gettingUrlId`、`playerStatus.isInitialized/isRegisteredService/isIniting`（`src/config/globalData.ts:26-30`）、`isPlayedStop`（第 41 行）、URL 来源（cache/toggle/refresh）、内存水位、定时器存活标志、`AppState`、是否处于"恢复播放"（`global.lx.restorePlayInfo`，第 32 行）。

5. **补充：内存内 `bootLog` 也不能用于事后排查**
   - `src/utils/bootLog.ts:1-10`：**纯内存 `logs: string[]`，无落盘、无大小上限、永不清理**。
   - 它只在「初始化失败」弹窗里被读取（`src/app.ts:22-27, 38, 71`）。**进程被杀后内容全丢**——恰恰是最需要它的场景。且 `src/app.ts:71` 那条路径连 `tryGetBootLog()` 都没带（只打 `Boot Log:\n\n`），是明显缺失。

---

## 6. Android 原生侧专项核查（"玩游戏更容易复现"）

### 6.1 前台服务（foreground service）

| 项 | 状态 | 证据 |
|---|---|---|
| `WAKE_LOCK` 权限 | **有**（来自 RNTP 库 manifest 合并） | `node_modules/react-native-track-player/android/src/main/AndroidManifest.xml:5`；合并后 `android/app/build/intermediates/merged_manifests/release/processReleaseManifest/universal/AndroidManifest.xml:20` |
| `FOREGROUND_SERVICE` 权限 | **有**（同上） | 同上 `:6`；合并后 `:21` |
| `MusicService` 声明 | **有**，`android:enabled="true" android:exported="true"`，带 `MEDIA_BUTTON` intent-filter | `.../AndroidManifest.xml:11-15`；合并后 `:137-144` |
| **`android:foregroundServiceType`** | **缺失** | `.../AndroidManifest.xml:11`（service 标签上无该属性）；合并后 `:137-140` 同样无 |
| **`FOREGROUND_SERVICE_MEDIA_PLAYBACK` 权限** | **缺失** | 合并后 manifest 权限区 `:11-28` 只有 `FOREGROUND_SERVICE`，没有 `FOREGROUND_SERVICE_MEDIA_PLAYBACK` |
| `targetSdkVersion` | **29** | `android/build.gradle:8`；合并后 `:9` |
| `minSdkVersion` | 21 | `android/build.gradle:6` |

**分析**：
- `targetSdkVersion 29` 使应用免于 Android 14（API 34）对 `foregroundServiceType` 的**强制**要求，所以"长期能在后台放"是合理的。但设备实际运行在 Android 12/13/14 上时，**系统仍会按运行时版本收紧前台服务策略**（尤其 Android 12 的 `ForegroundServiceStartNotAllowedException`、Android 13 的通知权限、Android 14 的 FGS 类型强制）。**声明缺失意味着一旦系统按新规则判定，`startForeground` 会抛异常**。
- 需注意：`startForeground` 是在 `MusicService.onCreate()` 里无条件调用的（见 6.2），**声明缺失 + 新系统 = 抛异常 = 服务创建失败**。

### 6.2 RNTP fork 的服务实现（关键风险点）

文件：`node_modules/react-native-track-player/android/src/main/java/com/guichaguri/trackplayer/service/MusicService.java`

- **第 24 行**：`public class MusicService extends HeadlessJsTaskService`。
- **第 31-33 行** `getTaskConfig`：`new HeadlessJsTaskConfig("TrackPlayer", Arguments.createMap(), 0, true)`。
- **第 36-38 行**：`onHeadlessJsTaskFinish(int taskId)` 被 **override 成空实现**，注释写"prevent the service from being terminated"。→ 设计意图就是长期驻留。
- **第 115-120 行 `onCreate()`**：
  ```java
  String channel = Utils.getNotificationChannel(this);
  startForeground(1, new NotificationCompat.Builder(this, channel).build());
  ```
  **无条件 `startForeground`，且没有 try/catch。**
  - 在 **Android 13+ 且 `POST_NOTIFICATIONS` 未授予**（`android/app/src/main/AndroidManifest.xml:13` 声明了权限，但运行时是否授予由用户决定，`src/utils/tools.ts:244-283` 只做弹窗提示，**用户可以选择"不再提示"**）的情况下，`startForeground` 可以抛 `ForegroundServiceStartNotAllowedException`/`SecurityException` → **服务创建失败 → 播放彻底不可用**，且这是 native 异常，**JS 侧完全无感知、无日志**。这与用户描述的"歌曲不播放"高度吻合（**推断，未在真机验证**）。
- **第 96-113 行 `onStartCommand`**：`return START_NOT_STICKY`（第 105、112 行）。→ **服务被系统杀死后不会被自动重建**。这是"长时间后被系统回收就再也不播"的机制性解释。
- **第 122-128 行 `onDestroy`**：`destroy()` + `stopForeground(true)`。
- **第 130-141 行 `onTaskRemoved`**：仅当 `manager == null || manager.shouldStopWithApp()` 才 `stopSelf()`。`shouldStopWithApp` 默认 `false`（`MusicManager.java:65`），且 `src/plugins/player/utils.ts:251-253` 把 `stopWithApp` 注释掉了（**不设置**）→ 从最近任务划掉应用**不会**停止服务（符合预期）。
- **第 61-83 行 `onStartForeground()`**：只在"无 React Activity"时短暂 `startForeground` 然后**立刻 `stopSelf()`**（第 80 行）。→ 这是给媒体键用的临时前台，**不是长效前台**。

### 6.3 WakeLock / WifiLock

文件：`node_modules/react-native-track-player/android/src/main/java/com/guichaguri/trackplayer/service/MusicManager.java`

- **第 74-76 行**：`wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "track-player-wake-lock"); wakeLock.setReferenceCounted(false);`
- **第 79-83 行**：`wifiLock = wifiManager.createWifiLock(WifiManager.WIFI_MODE_FULL, "track-player-wifi-lock");`
- **第 177-202 行 `onPlay()`**：第 193 行 `if(!wakeLock.isHeld()) wakeLock.acquire();`；第 195-197 行 非本地文件时 acquire wifiLock。
- **第 204-219 行 `onPause()` / 221-238 行 `onStop()`**：release 两个锁。
- **第 69 行 `@SuppressLint("InvalidWakeLockTag")`、第 177 行 `@SuppressLint("WakelockTimeout")`**：明确无超时释放。

**分析**：
- **有** PARTIAL_WAKE_LOCK，能防 CPU 休眠（不是"完全没锁"）。但 **`onPlay()` 通过 `playback.getCurrentTrack() == null` 就 `return`（第 182-183 行）→ 若当前 track 为空（例如列表被清空、或 track 处于 `//default` 临时态），wakeLock 不会 acquire**。
- 更关键：**`ExoPlayer.Builder(...).setWakeMode(WAKE_MODE_NONE)`（第 143 行）** = ExoPlayer 自己**不**持 WakeLock，完全依赖上面那把由 `onPlay/onPause/onStop` 手动管理的锁。**`onPlay()` 与 ExoPlayer 实际开始播放之间存在时序窗口**；且这把锁的 acquire 只在 JS/service 状态回调 `onPlay` 时发生——**若 JS 线程饥饿导致回调延迟，锁就延迟持有**。
- `wifiLock` 用 `WIFI_MODE_FULL`（第 81 行）——在新系统上 `WIFI_MODE_FULL` 已不保证高吞吐，且仅对非本地文件 acquire（第 195 行）。
- **结论**：WakeLock 不是"缺失"，而是**依赖 JS 侧回调正确触发 + 依赖 track 非空**；这与 Q2 的"JS 线程饥饿"问题耦合。

### 6.4 RN 主进程与 `largeHeap` / 内存回调

- `android/app/src/main/java/cn/toside/music/mobile/MainApplication.java:18`：`class MainApplication extends NavigationApplication`（RNN）。
  - 第 62-71 行 `onCreate()`：`DefaultNewArchitectureEntryPoint.load()`（第 66-69，`newArchEnabled=false` 见 `android/gradle.properties:37`）+ `ReactNativeFlipper.initializeFlipper(...)`（第 70 行）。**`onCreate` 里没有任何内存/生命周期日志。**
- `android/app/src/main/java/cn/toside/music/mobile/MainActivity.java`：**全文 13 行，完全空壳**（第 8-12 行），继承 `NavigationActivity`。→ **没有 `onTrimMemory`、没有 `onLowMemory`、没有 `onDestroy` 覆写、没有任何日志钩子**。
- `android/app/src/main/AndroidManifest.xml:15-24` 的 `<application>`：**没有 `android:largeHeap="true"`**。
- **全仓 `onTrimMemory`/`onLowMemory` 零命中**（grep `android/app/src/main/java`）。
- `android/app/build.gradle`：**没有 `dexOptions`/`javaMaxHeapSize` 相关配置**（见 105-188 行 `android {}` 块），也没有 `android:hardwareAccelerated`。

### 6.5 "玩游戏时更容易复现"的机制汇总

按证据强度排序：

1. **后台进程被系统回收（LMK / 内存压力）**：玩游戏是最典型的内存压力源。`MusicService` 是 `START_NOT_STICKY`（`MusicService.java:105, 112`）→ 被杀后**不重建**；前台服务又缺少 `foregroundServiceType` 声明 → 在 Android 12+ 更易被判违规而停服。**且进程被杀时 `error.log` 因异步 append 未 flush 而不落盘（Q5-2）**，所以用户拿不到任何证据。
2. **JS 线程被游戏抢占 CPU**：`src/core/init/player/playProgress.ts:67-69` 的 1s 轮询、`src/plugins/player/utils.ts:129-146` 的 800ms 防抖、`src/plugins/player/playList.ts:257-271` 的 500ms 防抖、`src/core/init/player/playerEvent.ts:19-34` 的 25s 加载超时 —— **全部依赖 JS 定时器或背景 timer**。JS 线程饥饿时：超时定时器不触发（Q2-b 的 fetch 超时也依赖 `BackgroundTimer`）→ 加载卡在"缓冲中"、进度不动、切歌不触发。
3. **`preloadNextMusic` 的 `isLoading` 死锁**（`src/core/init/player/preloadNextMusic.ts:19-35`）：一次卡住后预加载永久失效，后续每首歌都要现取 URL → 在弱网/高负载下表现为"歌不播"。
4. **WakeLock 依赖 `onPlay` 回调与 `currentTrack` 非空**（`MusicManager.java:177-202`），在 1/2 的组合下会出现"锁没拿到 → CPU 休眠 → 播放停摆"的窗口。

---

## 7. 建议埋点清单（供实现队友直接落地）

> 说明：以下埋点建议基于本文档 Q1-Q5 的证据。**埋点必须写文件（不只 console）**，并保证崩溃前可落盘。

### 7.1 日志基础设施要求（最高优先级）

| 需求 | 理由（证据） |
|---|---|
| **同步/立即落盘通道**（关键事件 `flushSyncBestEffort` 或等价手段） | Q5-2：`src/utils/log.ts:10` 是 `void appendFile`，进程被杀即丢 |
| **内存环形缓冲**（最近 N 条，可一键导出） | Q5-2/Q5-5；`src/utils/bootLog.ts:1-5` 是无界且不落盘的反面教材 |
| **文件轮转 + 总大小上限** | Q5-3：`error.log` 无上限 |
| **独立文件**（如 `runtime.log`），**不要污染 `error.log`** | 设置页 `Log.tsx` 按 `'\n----lx log----\n'` 切分（见 `src/utils/log.ts:65-121` 旧注释与 `getLogs()` 契约） |
| **保留 console 输出**（release 可用 adb 抓） | Q5-3：现有大量 `console.log` 不进文件 |
| **崩溃/被 kill 前的最后状态快照**（会话启动时间、当前曲、定时器存活） | Q5-2 |

### 7.2 逐点埋点

| # | 位置（文件:行） | 级别 | 建议字段 |
|---|---|---|---|
| L1 | `src/plugins/player/service.ts:69-73`（PlaybackError） | **ERROR（立即 flush）** | `err.code`、`err.message`、`err.stack`、`global.lx.playerTrackId`、`global.lx.gettingUrlId`、`playerState.playMusicInfo.musicInfo.id`、`playerState.isPlay`、`global.lx.isPlayedStop`、`playerStatus.isInitialized/isRegisteredService/isIniting`、`AppState.currentState` |
| L2 | `src/plugins/player/service.ts:79-112`（PlaybackState） | INFO（状态迁移才记） | 上一状态 → 新状态、耗时 ms、`playerTrackId`、`progress.nowPlayTime`；`None` 分支（84-86）尤其要记（TP 状态复位是异常信号） |
| L3 | `src/plugins/player/service.ts:113-176`（TrackChanged） | INFO | `info.track`、`info.nextTrack`、`await getCurrentTrackId()` 结果、`isEmpty()` 结果、耗时 |
| L4 | `src/plugins/player/service.ts:27-31, 205-213`（服务注册） | INFO | 注册进入/完成、`isInitialized` 标志、是否重复注册 |
| L5 | `src/plugins/player/index.ts:19-44`（`initial()`） | INFO + ERROR | 每步 `setupPlayer/updateOptions/setVolume/setPlaybackRate` 前后 + 耗时；**整段加 try/catch 并 log.error**；记录参数 `cacheSize/maxBuffer/waitForBuffer/audioOffload/handleAudioFocus` |
| L6 | `src/plugins/player/utils.ts:30-44`（`updateOptions`）、`157-205`（`setPlay/setStop/setPause/setCurrentTime/destroy`） | DEBUG→WARN on slow | 每次原生调用前后 + 耗时；**超过阈值（如 3s）升为 WARN** |
| L7 | `src/plugins/player/playList.ts:150-185`（`handlePlayMusic`） | INFO + ERROR | 四个 `TrackPlayer.*` await 各自耗时；`tracks[0].id`、`queue.length`、`list.length`、是否走到 `remove`（第 183 行）；**加 `.catch` 记录 rejection**（当前被 `playMusic()` 第 190-193 行的 `.finally` 吞掉） |
| L8 | `src/plugins/player/playList.ts:186-194`（`playMusic`） | WARN | 连续调用序号（`actionId`）、被丢弃的调用（`id != actionId`）、`playPromise` 是否长期 pending |
| L9 | `src/core/player/player.ts:230-270`（`handlePlay`） | INFO + ERROR | 进入/退出、`await setStop()` 耗时（**当前最可疑的无超时点**）、`restorePlayInfo` 是否为真、`playMusicInfo.listId/isTempPlay` |
| L10 | `src/core/player/player.ts:136-155`（`setMusicUrl`） | INFO + ERROR | `gettingUrlId`、成功 URL 的来源（cache/toggle/refresh）、失败原因、`finally` 里 `clearLoadTimeout` 是否执行（第 149-154 行） |
| L11 | `src/core/player/player.ts:76-134`（`delayRetry`/`getMusicPlayUrl`） | INFO + WARN | 重试轮次、`isRetryed`、`tooManyRequests` 分支、换源目标 source、每次递归耗时 |
| L12 | `src/core/init/player/playerEvent.ts:16-41`（25s 加载超时） | **WARN** | `prevTimeoutId` 是否等于当前曲 id（决定"刷新 URL"还是"切歌"）、两次分支结果 |
| L13 | `src/core/init/player/playerEvent.ts:89-115`（`handleError`） | WARN | `retryNum`、`isEmpty()`、`isActive()`（第 108 行决定"等待"还是"直接切歌"） |
| L14 | `src/core/init/player/player.ts:20-32`（`handleEnded`） | INFO | 是否 `isPlayedStop`、`playNext(true)` 前后 |
| L15 | `src/core/player/player.ts:415-509`（`playNext`） | INFO | 进入/退出、`playedList.length`、`filteredList.length`、`togglePlayMethod`、选中的 `nextIndex`、`handleToggleStop` 分支（425/429/472） |
| L16 | `src/core/init/player/preloadNextMusic.ts:18-36` | WARN | `isLoading` 置位/复位、每步耗时；**重点：`isLoading` 停留超过阈值（如 30s）报警**（Q2-c 死锁） |
| L17 | `src/core/init/player/playProgress.ts:41-42, 64-71, 155-165` | DEBUG + WARN | `getDuration()` 耗时；`startUpdateTimeout/clearUpdateTimeout` 调用；`isScreenOn` 变化；**interval 存活心跳（如每 60s 计次）**，停顿即暴露 JS 定时器停摆 |
| L18 | `src/utils/nativeModules/utils.ts:32-45, 88-101` | WARN | 权限弹窗 Promise 何时 resolve/是否永不 resolve（Q2-a 最后一项） |
| L19 | `src/core/init/index.ts:34-71` | INFO（每步落盘） | 现有 `bootLog()` 已覆盖节点名（36-64 行），**但它只在内存**（`src/utils/bootLog.ts`）→ 改为同时写文件；补上每步耗时与 `isInited` 状态 |
| L20 | `src/app.ts:11-77` | INFO + ERROR | `starting app`（11 行）、`Promise.all`（14）耗时、`import('@/navigation')`（48）耗时、`initNavigation` 回调进入/`pushHomeScreen` 前后（50-56）、每个 `catch` 分支（35/57/68）**必须在 exitApp 之前落盘** |
| L21 | `src/navigation/regLaunchedEvent.ts:7-24` | **WARN** | `launched` 标志置位时间；→ **建议增加"X 秒内未收到 appLaunched 则强制 push + 记日志"的兜底**（Q3-a 第 5 点） |
| L22 | `src/utils/errorHandle.ts:7-33, 35-41` | **ERROR（立即 flush）** | `isFatal`、`e.name/message/stack`、native exception 字符串；**在弹窗之前先落盘**（当前 32/39 行之后没有任何 flush） |
| L23 | `src/plugins/storage.ts:55, 66, 81, 92, 103, 114, 125, 140, 167, 191, 201` | 已有 `log.error` | **补 flush**，否则崩溃时同样丢 |
| L24 | 全局内存水位 | INFO（周期） | `playedList.length`、`playList.ts` 的 `list.length`、`otherSourceCache.size`、`getOtherSourcePromises.size`、`lrcTools.playHooks.length`、`PlaybackState`、`progress.nowPlayTime`。RN 侧可用 `global.performance?.memory`（Hermes 支持情况**未验证**），native 侧建议补 `onTrimMemory` 日志 |
| L25 | 新增 native 钩子（`MainActivity.java`，当前为空壳） | WARN | `onTrimMemory(level)` / `onLowMemory()` → 转 JS 日志；同时把 `android:largeHeap` 的取舍作为独立议题记录（**不改，只记录**） |

### 7.3 建议的兜底（与埋点配套，均属"改行为"，需 lead 决策）

1. **初始化超时竞赛**：`src/app.ts:50-51` 的 `handleInit()` 与超时竞速，超时后**仍然 push 首页**（降级）并把超时原因写日志，而不是弹窗+退出。
2. **`playInfo.ts:15` 的恢复播放移出启动关键路径**：改为 `void`（异步后台恢复），避免 `await playList()` 阻塞首页。
3. **给 `setStop`/`setPlay`/`TrackPlayer.*` 加超时包装**（如 5-10s），超时后记录并重建 player。
4. **`preloadNextMusic` 的 `isLoading` 加超时释放**。
5. **`MusicService` 补 `foregroundServiceType`（需评估 targetSdk 一致性）与 `POST_NOTIFICATIONS` 失败时的服务降级路径**（native 改动，跨出本 task 只读范围）。
6. **`log.ts` 的 `tempLog` 与 `bootLog` 合并为有界环形缓冲 + 落盘**。
7. **`plugins/lyric.ts:47-49, 54-56` 的 `indexOf` -1 保护**（`if (index > -1) splice(...)`），修 hook 泄漏。

---

## 8. 未验证 / 未能完成的项（诚实声明）

1. **所有结论均为静态阅读**。本会话 `pwsh` 与 `glob` 对 `lx-music-mobile` 子树不可用（`sandbox-local windows-acl temp grant materialization failed and its cleanup also failed`），因此**未运行 tsc / eslint / 单测 / 真机复现**，也未用 `adb logcat` 或 `dumpsys meminfo` 验证。
2. **`maxBuffer: 1000` 的单位语义未复核**。`src/plugins/player/index.ts:32` 传 1000；`MusicManager.java:128` 用 `Utils.toMillis(options.getDouble("maxBuffer", ...))`。若 `toMillis` 按"秒"处理，则为 ~16.7 分钟缓冲。**需读 `Utils.toMillis` 确认**（本次未读该文件）。
3. **`POST_NOTIFICATIONS` 缺失是否真的让 `startForeground` 抛异常，未在真机验证**。这是基于 Android 13+ 行为的**推断**（见 6.2）。
4. **`global.performance.memory` 在本项目 Hermes 版本下是否可用，未验证**。
5. **未逐行审阅**的文件（仅按调用关系定位，结论可能不完整）：`src/core/list.ts`、`src/core/dislikeList.ts`、`src/plugins/sync/**`、`src/screens/PlayDetail/**` 全量、`src/components/player/**`、`src/theme/**`、`android/app/src/main/java/.../lyric/**`、`.../userApi/**`（QuickJS）。
6. **`MusicService.java` / `MusicManager.java` 属 `node_modules`（fork 依赖）**，不在本仓库版本管理内。对它们的改动需通过 patch/升级 fork，**不属本次只读范围**。
7. **`src/utils/runtimeLog.ts` 与 `src/utils/stallWatchdog.ts` 是队友（logcore / task-2）在本会话期间新建的文件**（`src/utils/log.ts:1-17` 已改为转接 `runtimeLog`）。本文档的 Q5 描述的是**原始 `log.ts` 实现的问题**（基于改造前的证据：第 4/10 行等）。**下游实现者应以 `runtimeLog.ts` 的当前实现为准**，本文档 7.1 的"要求"可用于校验它是否覆盖了全部缺陷。我未修改这两个文件。
