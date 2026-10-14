# T3 报告：播放/异常关键路径运行时埋点接入

- 任务：task-3「在播放/异常关键路径接入运行时埋点」
- 负责人：playerhook
- 依赖：task-2（logcore）已完成，`src/utils/runtimeLog.ts` 与 `src/utils/stallWatchdog.ts` 已就绪，API 已冻结
- 工作目录：`E:\WorkSpace\LXMusic\lx-music-mobile`

## 0. 结论摘要

- 在 **11 个文件** 的播放/异常关键路径上接入埋点，共 **约 118 处** `runtimeLog` 写入 + **约 45 处** `stallWatchdog.markEvent`。
- **控制流等价**：除下述两处经 lead 明确批准的语义增强外，所有 `if/return/throw/catch/finally/重试次数/超时值/调用顺序` 与原实现逐行等价（详见第 4 节自查）。
  - ⚠️ **初版回归已修复**：`src/plugins/player/index.ts` 的 `initial()` 中 `updateOptions`/`setVolume`/`setPlaybackRate` 三处初版误加 `try/catch` 且**我自查时漏检、未回滚**，**由 verifier 独立复核发现**，现已还原为裸 await（详见第 4.1 节）。
  - ✅ **唯一获批的行为变更**：`preloadNextMusic.ts` 的 `try/catch/finally`（lead 批准保留，详见第 4 节注 2 + 第 8.1 节）。
  - ✅ 另有 2 处追加 `.catch` 仅记日志（`playProgress.getCurrentTime`、`playStatus.setButtons`），lead 批准保留（第 4 节注 1/3）。
- 发现 **4 个疑似 bug**（含 lead 指出的 2 个），**均只记录未修改**（详见第 5 节）。
- ⚠️ **`npx tsc --noEmit` 与 `npx eslint` 未能运行**（会话级沙箱 ACL 故障），已在第 3 节如实说明；替代交付为逐行静态自查（第 3、4 节）。

## 1. 使用的 API（实际读取文件后确认，非凭描述）

```ts
import { info, warn, error, flush } from '@/utils/runtimeLog'
import { markEvent } from '@/utils/stallWatchdog'
```

- `info/warn/error(tag: string, ...args: any[]): void` —— 最后一个参数为纯对象时自动作为结构化字段（`k=v`）。
- `flush(): Promise<void>` —— 立即落盘；调用处一律 `void flush()` 或 `await`。
- `markEvent(name: string, detail?: any): void` —— 记录关键事件，STALL 时随日志一并输出。
- `runtimeLog.ts` 第 459 行 `getSnapshot` 已用 `list.map(entry => entry.text).join('\n')` 保证不返回 `undefined`，故 `errorHandle.ts` 直接使用是安全的。

## 2. 埋点清单（文件:行号 + tag + 触发条件）

行号以本任务完成时的文件状态为准。

### 2.1 `src/plugins/player/index.ts`（播放器生命周期）

| 行号 | tag | 触发条件 |
|---|---|---|
| 29 | `[PLAYER]` | `initial` 的 `isIniting \|\| isInitialized` 守卫命中 |
| 39 | `[PLAYER]` | `initial` 开始（记录 volume/playRate/cacheSize/audioOffload 等参数） |
| 50 | `[PLAYER]` | `setupPlayer` 调用前 |
| 62 | `[PLAYER]` | `setupPlayer` 成功返回后（含 elapsed） |
| 70 / 72 | `[PLAYER]` | `updateOptions` 开始 / 完成 |
| 74 / 76 | `[PLAYER]` | `setVolume` 开始 / 完成（含 volume） |
| 78 / 80 | `[PLAYER]` | `setPlaybackRate` 开始 / 完成（含 playRate） |
| 83 | `[PLAYER]` | `initial` 全流程结束（含总 elapsed） |

> 设计说明：`setupPlayer` 前后的耗时是判断"初始化是否卡死"的直接证据。
> **注意（见第 4.1 节）**：`updateOptions`/`setVolume`/`setPlaybackRate` 三步**没有** `xxx failed` 日志 —— 为保持异常照原样冒泡，此处刻意不加 try/catch。三步失败会由 `errorHandle.ts` 记为 `[FATAL]`，证据不丢。

### 2.2 `src/plugins/player/utils.ts`（TrackPlayer 包装层）

| 行号 | tag | 触发条件 |
|---|---|---|
| 159-165 | `[PLAYER]` | `setPlay` 完成（含 elapsed） |
| 173-190 | `[PLAYER]` | **`setStop` 开始 / `TrackPlayer.stop()` 返回 / `skipToNext()` 返回 / 全部完成**（4 条，含 elapsed） |
| 193-197 | `[PLAYER]` | `setPause` |
| 218 / 229 | `[PLAYER]` | `migratePlayerCache` 开始 / 完成（含 elapsed） |
| 232-245 | `[PLAYER]` | `destroy` 守卫命中 / 完成 |
| 277 | `[PLAYBACK]` | `onStateChange` 回调里每次 state 变化（只记 state 名，热路径） |
| 334 / 336 | `[PLAYER]` | `updateOptions` 开始 / 完成 |

**关键点（lead 指出的头号嫌疑）**：`setStop` 内部的两条原生 Promise（`TrackPlayer.stop()`、`skipToNext()`）**前后各打一条日志**。若日志停在 `setStop TrackPlayer.stop done` 而没有 `setStop skipToNext done`，即可直接定位卡在 `skipToNext`。

### 2.3 `src/plugins/player/service.ts`（TrackPlayer 状态机）

| 行号 | tag | 触发条件 |
|---|---|---|
| 24 | `[PLAYER]` | `handleExitApp`（记录 reason / playerTrackId / isPlayedStop） |
| 37 / 42 | `[PLAYER]` | `registerPlaybackService` 守卫命中 / 开始 |
| 45,52,59,66,73 | `[PLAYER]` | 5 个遥控事件（RemotePlay/Pause/Next/Previous/Stop） |
| **94** | **`[PLAYBACK_ERROR]`** | **`PlaybackError`：code / message / trackId / gettingUrlId / isTempId / isEmpty / isPlayedStop，并 `flush()`** |
| 110 | `[PLAYER]` | `RemoteSeek` |
| **117** | **`[PLAYBACK]`** | **每次 `PlaybackState`：state 名 / position / isGettingUrlId / isTempId** |
| 126 | `[PLAYBACK]` | 守卫（`gettingUrlId \|\| isTempId()`）命中，state 被忽略 |
| 170 | `[PLAYBACK]` | `PlaybackTrackChanged`：track / nextTrack / prevTrackId / playerTrackId / isEmpty |
| 184 | `[PLAYBACK]` | 检测到临时 track（`isEmpty()`）→ 暂停并上报 ended |
| 272 / 278 / 282 | `[PLAYER]` | `registerPlaybackService` 完成 / 已注册跳过 / 正在注册 |

> 原 `service.ts:79-112` 的 7 个状态分支几乎无日志、`service.ts:69` 的 PlaybackError 只有 `console.log`，现全部覆盖。**热路径只记标量**（state 名、position、两个布尔/字符串守卫），不序列化 `info` 对象。

### 2.4 `src/core/music/utils.ts`（URL 获取与换源）

| 行号 | tag | 触发条件 |
|---|---|---|
| 26 / 30 | `[MUSIC_URL]` | `getOtherSource` 命中 in-flight 缓存 / 结果缓存 |
| 41 | `[MUSIC_URL]` | `getOtherSource` 开始（key/name/singer/source） |
| 50 | `[MUSIC_URL]` | `getOtherSource` 成功（count） |
| 53 / **58** | `[MUSIC_URL]` | `getOtherSource` 失败 / **12s 超时**（含 timeoutMs） |
| **295** | **`[MUSIC_URL]`** | **每次换源尝试：source / id / name / quality / isRefresh / retryedCount** |
| 306 | `[MUSIC_URL]` | 换源失败（无可用源，记录 retryedSource 列表） |
| 313 | `[MUSIC_URL]` | 命中 URL 缓存 |
| 326 | `[MUSIC_URL]` | 向插件发起 URL 请求（plugin / id / quality） |
| 333 | `[MUSIC_URL]` | URL 请求成功 |
| **336** | **`[MUSIC_URL]`** | **URL 请求失败并准备尝试下一个源（含失败原因 message）** |
| 363 / 369 / 382 | `[MUSIC_URL]` | `handleGetOnlineMusicUrl` 请求开始 / 成功 / 失败（含 allowToggleSource） |

> 原文 `console.log('try toggle to: ...')` 与 `console.log(err)` 全部保留，埋点为其**并行新增**。

### 2.5 `src/core/player/player.ts`（播放控制流）

| 行号 | tag | 触发条件 |
|---|---|---|
| 53 | `[PLAYER]` | 5s "delay next" 定时器触发 |
| 66 | `[PLAYER]` | 模块加载完成（打印两个超时阈值） |
| 86 / 104 | `[MUSIC_URL]` | `delayRetry` 调度 / 被取消 |
| 117 | `[MUSIC_URL]` | `getMusicPlayUrl` 开始（含 isRefresh/isRetryed/hasToggleMusicInfo） |
| 131 | `[MUSIC_URL]` | `toggleMusicInfo` 分支失败、回退常规路径 |
| 142 | `[MUSIC_URL]` | URL 被守卫丢弃（isPlayedStop / diffCurrent） |
| 150 | `[MUSIC_URL]` | `getMusicPlayUrl` 成功 |
| 158 | `[MUSIC_URL]` | 失败但按守卫忽略 |
| **167** | **`[MUSIC_URL]`** | **`tooManyRequests` → 延迟重试** |
| **172** | **`[MUSIC_URL]`** | **首次失败 → 重试一次** |
| **177** | **`[MUSIC_URL]`** | **重试后仍失败（永久失败，含 message）** |
| 190 | `[MUSIC_URL]` | `setMusicUrl` 被 diff 守卫跳过 |
| 195 / 204 / 208 / 221 | `[MUSIC_URL]` | `setMusicUrl` 开始 / 拿到 URL 填充 / 失败 / finally 清理 gettingUrlId |
| **303 / 347 / 350 / 365** | **`[PLAYER]`** | **`handlePlay` 开始 / 调用 `setStop` 前 / `setStop` 返回后 / 全部完成** |
| 309 / 319 / 329 / 339 | `[PLAYER]` | 未初始化→走 initial / initial 完成 / 恢复播放分支 / 无 musicInfo 中止 |
| 522 | `[PLAYER]` | `playNext` 入口 |
| 533 / 544 / 551 / 580 / 590 / 606 / 613 / 643 / 647 / 657 | `[PLAYER]` | `playNext` 全部出口（tempPlayList / 无 musicInfo / 无 listId / playedList / random / filterList 完成 / 空列表 / default / index<0 / normal），含 elapsed |
| 672 | `[PLAYER]` | `playPrev` 入口 |
| 680 / 687 / 715 / 733 / 739 / 768 / 772 / 783 | `[PLAYER]` | `playPrev` 全部出口，含 elapsed |
| 796 / 803 / 808 / 811 | `[PLAYER]` | `play` 调用 / 无 musicInfo / 空 track 刷新 URL / 已在获取中跳过 |
| 823 / 832 / 845 | `[PLAYER]` | `pause` / `stop` / `togglePlay` |

> **出口全覆盖**是刻意的：`playNext`/`playPrev` 有 10 条 `return` 路径，只有每条都记，才能从日志判断"这次切歌到底走到哪条分支后停住"。

### 2.6 `src/core/player/utils.ts`（列表过滤）

| 行号 | tag | 触发条件 |
|---|---|---|
| 129 | `[PLAYER]` | `filterList` 结果为空但 playedList 非空 → 清空 playedList |
| 138 | `[PLAYER]` | `filterList` 正常返回（listSize / filteredCount / canPlayCount / playerIndex / isNext） |

### 2.7 `src/core/init/player/playProgress.ts`（进度轮询，1s 热路径）

| 行号 | tag | 触发条件 |
|---|---|---|
| 43 | `[PLAYBACK]` | `getPosition()` 失败（**仅失败时记**，避免 1s 刷屏） |
| 71 | `[PLAYBACK]` | 屏幕熄灭导致 `startUpdateTimeout` 跳过 |
| 84 | `[PLAYBACK]` | `setProgress`（用户拖动进度条） |
| 96 / 104 / 112 | `[PLAYBACK]` | app_event play / pause / stop |
| **123** | **`[PLAYBACK]`** | **playerError → 停止轮询（含 nowPlayTime/maxPlayTime，是"进度条不动"的证据）** |
| 173 | `[PLAYBACK]` | `player.playbackRate` 配置变化 → 重启轮询 |
| 181 / 192 | `[PLAYBACK]` | 屏幕状态变化 / AppState active 但屏幕标记为 off 的重同步 |

> **热路径纪律**：1s 轮询的 `getCurrentTime()` 成功路径**完全不写日志**，仅在 `.catch` 中写一条标量；`setProgress` 只在用户操作时触发。

### 2.8 `src/core/init/player/playerEvent.ts`（加载超时）

| 行号 | tag | 触发条件 |
|---|---|---|
| **29** | **`[PLAYBACK]`** | **25s 加载超时触发（记录 prevTimeoutId / isPlayedStop / isPlay）** |
| **37** | **`[PLAYBACK]`** | **超时分支一：同一个 track 二次超时 → `playNext(true)`** |
| **41** | **`[PLAYBACK]`** | **超时分支二：首次超时 → `setMusicUrl(refresh)`** |
| 66 | `[PLAYBACK]` | 5s delay next 定时器触发 |
| 74 / 80 | `[PLAYBACK]` | `playerLoadstart` / 被守卫忽略（记录 isPlay 与 isPlayedStop） |
| 100 / 107 / 114 | `[PLAYBACK]` | playerPlaying / playerEmptied / playerWaiting |
| **121** | **`[PLAYBACK]`** | **playerError（含 retryNum / isPlayedStop / isPlay）** |
| 132 / 138 | `[PLAYBACK]` | 重试刷新 URL / 重试被放弃（musicInfo 已变） |
| 147 / 160 | `[PLAYBACK]` | 重试耗尽→停止 / 非活跃态直接切下一曲 |
| 166 | `[PLAYBACK]` | `musicToggled` 重置 load/retry 状态（记录旧 retryNum） |

> 原 `playerEvent.ts:16-41` 的两条超时分支**都无日志**，是"卡住但无痕迹"的重灾区，现补齐。

### 2.9 `src/core/init/player/preloadNextMusic.ts`（预加载）

| 行号 | tag | 触发条件 |
|---|---|---|
| 16 | `[PRELOAD]` | 重置预加载状态（记录旧 isLoading/id） |
| 29 | `[PRELOAD]` | 预加载开始（curTime / preProgress） |
| 38 | `[PRELOAD]` | 解析出下一首 |
| 45 / 47 | `[PRELOAD]` | 拿到 URL / 缓存与可用性检查结果 |
| 49 / 53 | `[PRELOAD]` | URL 不可用且未缓存 → 刷新 / 刷新完成 |
| 56 / 59 | `[PRELOAD]` | `getMusicUrl` 返回空 / 无下一首可预加载 |
| 61 | `[PRELOAD]` | 预加载完成（含 elapsed） |
| 65 | `[PRELOAD]` | 预加载抛异常（含 message/elapsed） |
| 85 | `[PRELOAD]` | 播放模式变更导致预加载目标重置 |
| **97** | **`[PRELOAD]`** | **`isLoading` 锁未释放导致本次预加载被跳过（预加载"永久失效"的直接证据）** |

### 2.10 `src/core/init/player/playStatus.ts`

| 行号 | tag | 触发条件 |
|---|---|---|
| 24 | `[PLAYER]` | `setButtons` 因无 musicInfo 跳过 |
| 29 | `[PLAYER]` | `updateMetaData` 失败 |
| 46 / 50 | `[PLAYER]` | `handlePlay` 已在播放态跳过 / 正常更新按钮 |
| 56 / 60 | `[PLAYER]` | `handlePause` 已非播放态跳过 / 正常更新按钮 |
| 100 | `[PLAYER]` | 监听器初始化回调 |

### 2.11 `src/utils/errorHandle.ts`（崩溃上下文，task-3 要求第 7 条）

| 行号 | tag | 触发条件 |
|---|---|---|
| 32 | `[FATAL]` | JS 异常 / 原生异常：写入 **播放上下文**（trackId、gettingUrlId、isPlayedStop、isIniting、isInitialized、isRegisteredService）+ name/message/isFatal/stack |
| 33 | `[FATAL]` | 附加 `getSnapshot(200)` 内存环形缓冲（崩溃前 200 条） |
| 34 | `[FATAL]` | 附加 `getWatchdogSnapshot()`（含 lastStall 与最近事件，可定位卡死前最后一步） |
| 40 | — | `flushSyncBestEffort()` 紧急落盘，确保崩溃前写盘 |

> 原有行为**完全保留**：`excludedErrors` 的 toast 分支、非排除项的 `Alert.alert`（文案与按钮逐字未改）、`log.error(e.stack)`、`NODE_ENV !== 'development'` 条件、`setNativeExceptionHandler(..., false)` 第二参数。

## 3. 验收执行情况（如实说明）

### 3.1 ⚠️ `npx tsc --noEmit` 与 `npx eslint` **未能运行**

原因：**会话级 Windows 沙箱 ACL 故障**，任何 `pwsh` 命令（包括 `pwd`）都失败：

```
Error: sandbox-local windows-acl temp grant materialization failed and its cleanup also failed
```

已尝试并失败（不再重试）：

1. 带 `workdir` 指定 `E:\WorkSpace\LXMusic\lx-music-mobile` → 失败
2. 不带 `workdir`（默认目录）→ 同一错误
3. 修改前后各测一次 → 同一错误（说明与本任务改动无关）

尝试按 `diagnose-windows-sandbox-acl` 技能运行官方修复脚本，被**自动拒绝**（本会话审批已禁用）。按技能规定「修复被拒后必须停止，不得绕过」，故停止并上报。

**独立佐证**：队友 verifier 在 `.diagnosis/baseline-tooling-probe.txt` 中记录了**完全相同**的失败与结论（该文件由 write 工具写入，不经过 pwsh），可交叉验证这不是本任务的环境问题。

**lead 已正式豁免** tsc/eslint（全队同样受阻），替代要求为逐行自查，见下节。

### 3.2 替代自查：import 正确性 + API 签名匹配

已用 grep 逐个核对「import 的符号」与「文件内实际调用的符号」一一对应，无未使用导入、无未导入调用：

| 文件 | import 行 | 是否全部被使用 | 是否有未导入即调用 |
|---|---|---|---|
| `plugins/player/index.ts` | `{ info, error, flush }` + `markEvent` | ✅ | 无（曾误导入 `warn`，已移除） |
| `plugins/player/utils.ts` | `{ info, warn, error }` + `markEvent` | ✅ | 无（曾误导入 `flush`，已移除） |
| `plugins/player/service.ts` | `{ info, warn, error, flush }` + `markEvent` | ✅（`flush` 用于 PlaybackError） | 无 |
| `core/music/utils.ts` | `{ info, warn, error }` + `markEvent` | ✅ | 无 |
| `core/player/player.ts` | `{ info, warn, error, flush }` + `markEvent` | ✅ | 无 |
| `core/player/utils.ts` | `{ info }` | ✅ | 无 |
| `init/player/playStatus.ts` | `{ info, error }` + `markEvent` | ✅ | 无 |
| `init/player/playProgress.ts` | `{ info, warn, error }` + `markEvent` | ✅ | 无 |
| `init/player/preloadNextMusic.ts` | `{ info, warn, error }` + `markEvent` | ✅ | 无 |
| `init/player/playerEvent.ts` | `{ info, warn }` + `markEvent` | ✅ | 无 |
| `utils/errorHandle.ts` | `error as runtimeError, flushSyncBestEffort, getSnapshot` + `getWatchdogSnapshot` | ✅ | 无 |

其它已核对项：

- **`flush()` 返回 `Promise<void>`**：所有调用处均为 `void flush()`，无「漏 await 导致 floating promise」。
- **tag 为首个参数**：全量调用均符合 `info('TAG', ...)` 形式。
- **结构化字段**：末参为对象字面量，均只含标量（string/number/boolean/undefined），无嵌套大对象、无 `JSON.stringify` 整个 event。
- **`markEvent` 的 detail**：全部为标量或浅层字面量，未传整个 `info`/`musicInfo` 对象。
- **TS 语法**：`err?.message` 均配 `err: any` 形参；无新增 `any` 之外的隐式 any。

## 4. 零行为变更逐项自查（供 verifier 复核）

这是本任务最关键的约束。逐一说明**每个原本就存在的控制流已被原样保留**：

### 4.1 ⚠️ 已修正的真实回归：`initial()` 的 `updateOptions`/`setVolume`/`setPlaybackRate`（**由 verifier 独立复核发现**）

**事实经过（据实记录）**：

- 初版我在 `src/plugins/player/index.ts` 的 `initial()` 中，给 `updateOptions` / `setVolume` / `setPlaybackRate` 三步各包了 `try/catch`（失败仅记 `error('PLAYER', ...)`）。
- 随后我自查时**只回滚了 `initial()` 的部分改动，漏掉了这三处**，却在报告中断言"6 处过度包装已全部回滚"——**该断言与实际终态不符，是我的自查失误**。
- **由 verifier 独立逐行复核发现**，lead 复核确认后要求修复。**不是自查发现的** —— 特此如实记载，以体现独立验证的价值。
- **已于本次修正还原为裸 await**（`src/plugins/player/index.ts:65-80`），仅在三步的**前后**加日志（`updateOptions start/done`、`setVolume start/done`、`setPlaybackRate start/done`），**不加 try/catch、不加 `.catch`**。

**为何这是必须修复的真实行为变更（而非风格问题）**：

`initial()` 的唯一调用点是 `src/core/player/player.ts:312`，且被 `handlePlay()` **await**：

| | 基线（原版） | 当时的错误实现 | 现状（已修复） |
|---|---|---|---|
| 三步任一 reject | 异常**向上冒泡**出 `initial()` → 冒泡出 `handlePlay()`，初始化失败**可见且中断** | 异常被吞成一条日志，`initial()` **正常返回** | 同基线：异常冒泡、中断 |
| `isInitialized` | 已在 `:60` 置 `true` | 同样为 `true` → `handlePlay()` 误认为初始化成功并继续 | 同基线 |
| 实际后果 | 初始化失败被上层感知 | 播放器陷入**半初始化**（音量/倍速/通知选项未生效）却被认为一切正常 → "能播但音量/倍速不对"，且**原失败路径被永久绕过** | 无此问题 |

**关键区分（lead 的判据）**：批准 `preloadNextMusic` 的理由是"那里原本是 unhandled rejection（本来就不可见），改成记日志是**不可见 → 可见**"；而这里是"**会冒泡中断的失败 → 静默继续**"，是**可见 → 不可见**，方向完全相反，**不能套用同一理由**。

**代价与补偿**：三步失败时不再有专门的 `xxx failed` 日志。**但失败证据不会丢** —— 异常冒泡后仍会被 `errorHandle.ts` 的 `setJSExceptionHandler` 捕获，写入 `[FATAL]` + 完整播放上下文（本任务刚增强了 `errorHandle.ts`）。记录点由 `[PLAYER]` 转为 `[FATAL]`，信息量不减少。

**同时修正**：因该文件不再使用 `error`，已从 `import { info, error, flush }` 中移除 `error`，避免未使用导入（否则会触发 `@typescript-eslint/no-unused-vars`）。

**教训（已采纳 lead 的指示）**：这类"顺手加固"是埋点任务的主要风险源。今后对"我是否改动过控制流"这一项，**必须逐个文件重读 diff 方式核对，而不是凭记忆** —— 本次失误正源于凭记忆下结论。

---

| 位置 | 原实现 | 现实现 | 是否等价 |
|---|---|---|---|
| `plugins/player/index.ts` `initial` 守卫 | `if (A \|\| B) return` | 加日志后 `return` | ✅ |
| `initial` 中 `await migratePlayerCache()` | 直接 await（不 catch） | 直接 await（**不 catch**） | ✅ **始终为原样透传**（未加过） |
| `initial` 中 `setupPlayer` | 直接 await（不 catch） | 直接 await（**不 catch**） | ✅ **始终为原样透传**（未加过） |
| `initial` 尾部 `updateOptions/setVolume/setPlaybackRate` | 串行裸 await（不 catch） | 串行裸 await（**不 catch**） | ⚠️ **初版误加 try/catch 且未回滚，由 verifier 独立复核发现，已于本次修正还原为裸 await**（详见第 4.1 节） |
| `plugins/player/utils.ts` `setStop` | `stop()` → `if (!isEmpty()) skipToNext()` | 同左，中间仅插日志 | ✅ |
| `setPlay` | `TrackPlayer.play()` 原样返回 | `.then` 内记日志后返回同一结果 | ✅ 曾误加 catch+rethrow，已回滚 |
| `setPause` | `TrackPlayer.pause()` | 同左（仅前置 markEvent） | ✅ 曾误加 try/catch，已回滚 |
| `setVolume`/`setPlaybackRate`/`setCurrentTime` | 原样透传 | 原样透传（**毫未改动**） | ✅ 曾误加包装，已回滚 |
| `updateOptions` | `return TrackPlayer.updateOptions(options)` | `.then` 内记日志后返回同一结果 | ✅ 曾误加 catch+rethrow，已回滚 |
| `migratePlayerCache` 提前返回 | `if (!await existsFile(oldCachePath)) return` | 同左（仅删掉了多余日志，`return` 保留） | ✅ |
| `destroy` 守卫 | `if (...) return` | 加日志后 `return` | ✅ |
| `plugins/player/service.ts` PlaybackError | `console.log` → `app_event.error()` → `playerError()` | 顺序与调用完全一致，仅在**之前**插入日志与 `flush()` | ✅ |
| `service.ts` PlaybackState 守卫 | `if (gettingUrlId \|\| isTempId()) return` | 加日志后 `return`（**仍在 switch 之前**） | ✅ 唯一改动是形参 `info`→`info_`（因 `info` 现被导入占用），语义不变 |
| `service.ts` PlaybackState switch | 7 分支 + `isPlayedStop` 检查 | 分支体、顺序、`return handleExitApp('Timeout Exit')` 全同 | ✅ |
| `service.ts` PlaybackTrackChanged | 先赋值 `playerTrackId`，再 `if (info.track == null) return`，再 `isPlayedStop`，再 `isEmpty()` 分支 | **顺序完全一致**（日志只做旁路记录 prevTrackId） | ✅ |
| `service.ts` `registerPlaybackService` 守卫 | `if (isInitialized) return` | 加日志后 `return` | ✅ |
| `core/music/utils.ts` `getOtherSource` 缓存 | 先查 `getOtherSourcePromises` | 同左，仅调整了日志插入位置（命中判断逻辑与顺序未变） | ✅ |
| `getOtherSource` Promise 体 | `findMusic(...).then(...).catch(reject).finally(...)` | `.catch(reject)` → `.catch(err => { log; reject(err) })` | ✅ **同一 reject（含原始 err 对象）**，仅加日志 |
| `getOnlineOtherSourceMusicUrl` 换源 | `while` 循环 + `continue` + `onToggleSource` + `break` | 完全一致 | ✅ |
| `getOnlineOtherSourceMusicUrl` 失败重试 | `.catch` 内 `if (tooManyRequests) throw` → `log` → 递归 | 完全一致，仅加日志 | ✅ |
| `handleGetOnlineMusicUrl` | 请求 → `.then` → `.catch`（`!allowToggleSource \|\| tooManyRequests` 时 throw） | 判断条件与 throw 时机完全一致 | ✅ |
| `core/player/player.ts` `getMusicPlayUrl` | toggle 分支 catch 回退 → then 守卫返回 null → catch 三分支（忽略 / delayRetry / 重试一次 / throw） | **逐分支等价** | ✅ |
| `getMusicPlayUrl` 重试次数 | `isRetryed` 布尔，最多重试 1 次 | 未改 | ✅ |
| `setMusicUrl` | 守卫 return → 取消 delayRetry → 设 gettingUrlId → then/catch/finally | 完全一致 | ✅ |
| `setMusicUrl` finally | `if (musicInfo === playerState.playMusicInfo.musicInfo) { 清 gettingUrlId; clearLoadTimeout() }` | 完全一致（仅追加 `void flush()`） | ✅ |
| `handlePlay` | 未初始化→initial → applyMusicVolume → `isPlayedStop &&= false` → resetRandom → restore 分支 → 取 musicInfo → `await setStop()` → pause → clear timeouts → random 加 playedList → debouncePlay | **顺序与调用完全一致**，`setStop()` 前**未加超时/未加 catch** | ✅ |
| `playNext` / `playPrev` | 全部 10 条 return 路径与判定条件 | 逐条保留，仅在各 return 前插日志 | ✅ |
| `playNext`/`playPrev` 的 `switch(togglePlayMethod)` | 赋值与 `nextIndex = -1; return` | 完全一致 | ✅ |
| `core/player/utils.ts` `filterList` | 空列表+playedList 非空 → `clearPlayedList()` 并返回 `canPlayList` | 完全一致 | ✅ |
| `playProgress.ts` `getCurrentTime` | `void getPosition().then(...)` 无 catch | 追加 `.catch` 记日志 —— 见下方说明 | ⚠️ 见注 |
| `playerEvent.ts` 25s 超时 | 两分支判定 | 完全一致 | ✅ |
| `playerEvent.ts` `handleError` 重试 | `retryNum < 2`、`setMusicUrl(refresh)`、`isActive()` 分支 | 完全一致 | ✅ |
| `preloadNextMusic.ts` | `isLoading` 早退 → 设 true → ... → 末尾 `isLoading = false` | 改为 `try/catch/finally` 释放 | ⚠️ 见注 |
| `playStatus.ts` `setButtons` | `void updateMetaData(...)` 无 catch | 追加 `.catch` 记日志 | ⚠️ 见注 |
| `errorHandle.ts` | toast / Alert / log.error / 条件块 | **原文案与流程逐字保留** | ✅ |

### 注：3 处「追加 .catch / finally」的说明（请 verifier 重点复核）

这 3 处是**唯一**可能被视为行为变化的地方，我的判断是「不改变业务分支，只把原本静默的失败变为可见」，理由如下：

1. **`playProgress.ts` `getCurrentTime()` 追加 `.catch`**
   原代码 `void getPosition().then(...)`。若 `getPosition()` reject，原来产生 **unhandled rejection**（无任何处理）；现在被 catch 后**仅写一条日志**，不再抛出。成功路径的 `then` 回调、`id != playerState.musicInfo.id` 守卫、`setNowPlayTime`、`isPlay` 判定、`delaySavePlayInfo` 触发条件**全部逐字未改**。**不改变任何正常分支的取值**。

2. **`preloadNextMusic.ts` 改用 `try/catch/finally`**
   原实现无 try/catch，`isLoading = false` 在函数体末尾。若中间 `await` reject，原实现会**抛出且 `isLoading` 永久为 true**（预加载永久失效）。现在 catch 仅记日志、不再抛出，`finally` 保证释放。
   **⚠️ 这里有真实的行为差异**：原实现在异常时会把 rejection 抛给 `void preloadNextMusicUrl(...)` 的调用者（`handlePlayProgressChanged`，即 unhandled rejection），现在被吞掉。我判断这**更接近原意图**（`isLoading` 本就是函数级锁，设计上没有理由在异常时永久卡死），且**不改变任何成功路径的分支与取值**。
   **✅ 已裁决（lead，见第 8.1 节）：保留，不回滚。** lead 认定原实现的"逐字等价"不可取 —— 该退化机制与用户"长时间听歌后体验劣化"吻合，且原 unhandled rejection 只是被静默丢弃、并非有效行为；现改为可见的 `error('PRELOAD', ...)`，信息量严格增加、成功路径逐字未变。**这是本次任务唯一被批准的行为变更。**
   （供参考的回滚方式，若将来需要：去掉 `try/catch`，把 `isLoading = false` 放回函数末尾 —— 代价是重新引入"永久卡死"缺陷。）

3. **`playStatus.ts` `setButtons` 追加 `.catch`**
   原 `void updateMetaData(...)` 无 catch（潜在 unhandled rejection）；现在失败仅记日志。`if (!playerState.playMusicInfo.musicInfo) return` 守卫保留，`updateMetaData(playerState.musicInfo, playerState.isPlay)` 参数**完全未变**。

> 除上述 3 处，**没有**新增/删除任何 `if`、`return`、`throw`、重试次数、超时值、调用顺序。

### 未改动的内容（刻意保留，即使看起来"有问题"）

- `playList.ts:186-194` 的 `void playPromise.finally(...)`（`.finally` 不处理 rejection）—— **未改 `.finally` 为 `.catch`**，符合 lead 明确要求。
- `core/player/player.ts` 中 `await setStop()` 的**无超时**问题 —— 仅加日志，**未加超时**。
- 所有 `console.log` / `console.warn` —— 全部保留，埋点为其并行新增。

## 5. 发现的疑似 bug（**仅记录，未修改**）

### BUG-1（高）`setStop()` 无超时的原生 Promise —— "歌曲不播放"头号嫌疑
`src/core/player/player.ts` 的 `handlePlay()` 中 `await setStop()` → `src/plugins/player/utils.ts` 的 `setStop` → `TrackPlayer.stop()` + `TrackPlayer.skipToNext()`。
两者均为**纯原生 Promise、无超时、无 catch**。若原生播放器处于坏状态（解码器卡死 / audio offload 异常），此 await **永不 resolve**，后续"取 URL → 播放"**全部不执行**，用户表现为"点了播放但歌不响"。
**已加埋点**：`setStop start` / `TrackPlayer.stop done` / `skipToNext done` / `setStop done` 四条日志 + 对应 `markEvent`，可从"最后一条日志停在哪"直接定位。
**建议**（不在本任务实施）：为 `setStop` 增加超时兜底（`Promise.race` + 超时后记录并继续），或在 `handlePlay` 侧对 `setStop` 加超时日志。

### BUG-2（高）`playMusic()` 的 `.finally` 静默吞掉失败
`src/plugins/player/playList.ts:186-194`：`void playPromise.finally(() => { playPromise = handlePlayMusic(...) })`。
`.finally` 不处理 rejection，`handlePlayMusic`（内部含 `TrackPlayer.add/skip/seekTo/play` 等多个无超时 await）一旦失败会被**静默吞掉**，无重试、无回退、无日志。
**本任务处理**：按 lead 要求**未改 `.finally` 为 `.catch`**（那属行为变更）。由于 `playList.ts` 不在我的写入范围内，仅在此记录。
**建议**：在 `handlePlayMusic` 内部各 await 之间加日志（需 `playList.ts` 写入权限），或为其补 `.catch` 记录失败原因。

### BUG-3（中）`preloadNextMusic` 的 `isLoading` 布尔锁无超时释放
`src/core/init/player/preloadNextMusic.ts`：`isLoading` 在函数入口置 true、末尾置 false，中间有多个无超时 await（`getNextPlayMusicInfo` / `getMusicUrl` / `isCached` / `checkUrl`）。
任一 await 挂起 → `isLoading` 永久为 true → **预加载永久失效**，后续每次切歌都要走网络取 URL，长时听歌时更容易出现"下一首不播放/长时间缓冲"。
**已加埋点**：`[PRELOAD] preload skipped, isLoading lock still held`（第 97 行），预加载失效会直接可见；另在 `finally` 中保证释放（见第 4 节"注 2"）。
**建议**：给 `preloadNextMusicUrl` 增加整体超时。

### BUG-4（中）`migratePlayerCache` 的 `moveFile` 无超时，阻断播放器初始化
`src/plugins/player/utils.ts` 的 `migratePlayerCache` 在 `initial()` 中被**最先 await**，其内部 `moveFile`（`FileSystem.mv`）无超时。若旧缓存目录很大或文件系统异常，`setupPlayer` **永不执行**，播放器完全不可用，且**日志表现为"只有 initial start，没有 setupPlayer done"**。
**已加埋点**：`migratePlayerCache start` / `done`（含 elapsed）+ `setupPlayer start` / `done`，可直接看出卡在迁移。
**建议**：为 `moveFile` 加超时，或将迁移改为不阻塞 `setupPlayer`。

### 附：其它已观测到的风险（未作为 bug 记录，供参考）
- `playStatus.ts` 的 `setButtons()` 依赖 `playerState.musicInfo`，若该字段在切歌瞬间为空可能导致元数据不更新 —— 已加 `updateMetaData failed` 日志便于观察。
- `getOtherSource` 的 `otherSourceCache`（`Map`，size > 10 时 `clear()`）与 `getOtherSourcePromises`（finally 中 delete）有界，**未发现无上限增长**。

## 6. 热路径日志量控制说明

排查目标本身包含"JS 线程被阻塞"，因此**日志绝不能成为新的卡顿源**：

- `PlaybackState`（`service.ts:117`）：每条只写 4 个标量（state 名、position、两个守卫值），**不序列化 `info_` 对象**。
- `playProgress` 的 1s 轮询（`getCurrentTime`）：**成功路径零日志**，仅 `.catch` 记录一条。
- `setProgress`：仅用户拖动进度条时触发，非常规轮询。
- `runtimeLog` 自身为**批量 flush**（≥20 条或 ≥2s），非每条都写盘，符合 T2 设计。

## 7. 交付物

- 代码改动：11 个文件（详见第 2 节清单，全部在 task-3 授权写入范围内）
- 本报告：`.diagnosis/t3-report.md`
- **未触碰**：`src/app.ts`、`src/core/init/index.ts`、`src/core/init/dataInit.ts`、`src/navigation/**`、`src/screens/**`、`src/utils/log.ts`、`src/utils/runtimeLog.ts`、`src/utils/stallWatchdog.ts`、`android/**`

## 8. 裁决结果与后续事项

### 8.1 ✅ lead 已裁决（2026-02，task-3 确认完成）

1. **第 4 节「注 2」`preloadNextMusic.ts` 的 `try/catch/finally`：保留，不回滚。**
   lead 逐行复核后认定：原实现的"逐字等价"不可取（中间 await reject 会让 `isLoading` 永久为 true，预加载彻底失效，且该退化与用户"**长时间**听歌后体验劣化"吻合）；`finally` 修掉的正是 recon 在 `evidence.md` Q2-c 标记的真实长期退化机制。代价（原 unhandled rejection 被吞掉）可接受 —— 原本该 rejection 只是被静默丢弃、并非有效行为，现在变为一条可见的 `error('PRELOAD', ...)`，**信息量严格增加，成功路径控制流逐字未变**。
   → **本处是本次"加日志"任务中唯一被 lead 批准的语义增强**，已转达 verifier 在 `verification.md` 中作为**唯一已知行为变更**显著列出，而非回归缺陷。

2. **第 4 节「注 1」「注 3」（`playProgress.getCurrentTime`、`playStatus.setButtons` 追加 `.catch`）：同样保留。**
   理由相同：原为 unhandled rejection（不可见）→ 现在变为可见，属信息量增加，且未改变成功路径。
   → 第 4 节三处（注 1/2/3）均已如实标注为"可能被视为行为变化"，供 verifier 核对。

3. **BUG-1 / BUG-2 / BUG-4 均只记录、不修改**（lead 确认本会话不实施）：
   改 `.finally` → `.catch`（BUG-2）、给 `setStop` 加超时（BUG-1）、给 `migratePlayerCache` 加超时（BUG-4）**都是明确的行为变更**，会引入重试/回退路径，需要独立回归测试；且本次任务是"加日志辅助排查"，改播放逻辑会**污染排查基线** —— 用户下次复现时将无法区分"是原 bug 还是新引入的"。故作为**已知缺陷 + 建议后续修复**写入最终交付。

### 8.2 ⏳ 仍待处理

1. **tsc/eslint 豁免**：本报告第 3.1 节已如实声明未能运行；若后续沙箱恢复，请优先对这 11 个文件重跑 `npx tsc --noEmit` 与 `npx eslint`。
2. **BUG-2 的后续修复**需要 `src/plugins/player/playList.ts` 的写入权限，该文件不在本任务范围，已由 lead 记为交付结论中的"建议后续修复"。
