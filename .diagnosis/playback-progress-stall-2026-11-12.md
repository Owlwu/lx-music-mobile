# 播放进度卡死（04:37 / 277.42s）：现场判读与修复（2026-11-12）

> 现象：播放《おかえり》（本地 FLAC，duration=330.47s）到 **04:37** 后进度条不再前进，
> 期间没有报错、没有闪退，界面一直「缓冲中」，只能手动切歌；用户回前台看到进度停在 04:37。
> 诊断文件：`lx-diagnostics-2026-11-12T06-07-55-173Z.txt`（App 1.9.1，Xiaomi 25102RKBEC，
> Android API 37，本轮进程已跑约 4.3 小时）。

## 0. 一句话结论

**不是 JS 卡死，也不是内存/桥线程问题，而是原生播放器的音频输出进入了「反复重建 AudioTrack」的死循环：**
同一首歌在第 277.42s 处，ExoPlayer 持续 `BUFFERING → PLAYING → BUFFERING …`（约 0.58s 一轮，
持续 60s 以上），`position` 固定不再前进；而 App 侧**没有任何恢复机制**能覆盖这种状态，
UI 反而因为「缓冲 = 暂停」的映射每秒闪一次暂停/播放，看起来就是进度条冻住。

## 1. 现场证据（诊断文件行号）

### 1.1 位置确实冻结在 277.42s（原生层，不是只看 UI）

- `L14`（live state / player store）：`nowPlayTime:277, maxPlayTime:330`
- `L15`（native player）：`state:"Playing"/"Paused"`、`position:277.418`、`duration:330.467`、`buffered:295.85`
- 崩溃前最后一次心跳 `L405`（14:06:52.455）：`position=277.42 buffered=296.58 state=Playing stateNum=3`

`buffered ≈ 296s` 而 `position = 277.4s`：数据早就读到播放点之后约 19s 了，
所以不是「网络/磁盘读不出来」，而是**音频输出没有在消费**。

### 1.2 卡死从 14:06:48 开始，形态是「音频轨反复失活/重建」

原生诊断日志（独立于 JS 线程）：

```
L1801 14:06:48.690 AUDIO playbackConfigChanged activeMedia=0 total=1     ← 音频轨失活
L1802 14:06:49.828 TP playback-state state=6(BUFFERING)
L1804 14:06:49.837 AUDIO playbackConfigChanged activeMedia=1 total=2     ← 音频轨重建
L1805 14:06:49.917 TP playback-state state=3(PLAYING)
L1807 14:06:50.482 TP playback-state state=6(BUFFERING)                  ← 0.58s 后又来一轮
...
L1879 14:06:59.687 TP playback-state state=3(PLAYING)
...（此后每 ~0.58s 一轮，一直持续到用户 14:07:45 手动暂停）
```

每一轮 `BUFFERING` 都精确伴随一次 `AUDIO playbackConfigChanged` 的
`activeMedia 1 → 0 → 1`，也就是 **AudioTrack 被释放又重建**；两次 `BUFFERING` 之间
`position` 完全不前进。

### 1.3 同一位置可复现（排除偶发设备抖动）

用户在 14:07:18 / 14:07:20 手动切到上一首、再切回（`L1361`、`L1406`），并在
`L1443`（14:07:21.298）`setProgress time=257.82` 恢复到 257.8s 重新播放：

```
L1458 14:07:25.395 RENDER progress rendered nowPlayTime=261
L1459 14:07:31.403 RENDER progress rendered nowPlayTime=267
L1460 14:07:36.423 RENDER progress rendered nowPlayTime=272
L1461 14:07:41.438 RENDER progress rendered nowPlayTime=277
L1462 14:07:43.029 state=Buffering        ← 又卡在同一位置
L2062 14:07:42.218 AUDIO activeMedia=0
L2063 14:07:43.028 TP state=6(BUFFERING)
...（同样的 0.58s 抖动循环再次出现）
```

**重新 prepare、重新取 URL、重新 seek 之后，仍然在 277.4s 卡死** → 触发点跟着「这首歌的音频数据/解码路径」走，
不是随机的时间点，也不是 JS 状态残留。

### 1.4 卡死期间 JS 全程健康（与 2026-10-27 的 OOM/桥线程死亡不是同一类问题）

- `L17`：`stallCount=0`、`jsUnresponsiveMs=0`、`jsAckEver=1`、`nativeModulesThread=1`、`tpEvents=783`、`droppedLines=0`
- `L19-53`：看门狗 `running:true / stallCount:0`，心跳 `seq:506`、`lastTickAgoMs:2440`
- 全程还在正常打 `[PLAYBACK] state / [PLAYER] playStatus / [RENDER] progress rendered` 日志
- 同期 `javaHeapMB=72 / maxHeapMB=256`，没有 `UNCAUGHT`，也没有 `JS_UNRESPONSIVE`

所以 JS 线程、RN 桥、内存都不是这次的原因；**UI 上"进度条不动"是原生 position 真的不动**。

### 1.5 App 侧把「缓冲」当成了「暂停」，放大成 UI 抖动

`src/plugins/player/service.ts` 原来的 `TPState.Buffering` 分支：

```ts
case TPState.Buffering:
  global.app_event.pause()      // ← 把 isPlay 改成 false、停掉进度轮询
  global.app_event.playerWaiting()
```

于是日志里每 0.58s 出现一对：

```
L1463 14:07:43.029 [PLAYBACK] ui state -> paused
L1465 14:07:43.030 [PLAYBACK] progress handler: pause
L1466 14:07:43.030 [PLAYBACK] progress polling stopped reason=pause event
L1470 14:07:43.112 [PLAYBACK] ui state -> playing
L1473 14:07:43.112 [PLAYBACK] progress polling started reason=play event armSeq=71
```

`progress polling armSeq` 在 1 分钟里从 66 涨到 75，就是被反复停/启。用户看到的就是：
进度条不动 + 按钮在「播放/暂停」之间闪 + 状态栏一直「缓冲中」。

## 2. 为什么一直不恢复（App 侧缺陷）

原有三条兜底**全都覆盖不到这个状态**：

| 兜底 | 源码位置 | 为什么没触发 |
| --- | --- | --- |
| 加载超时 25s → 刷新 URL / 切歌 | `core/init/player/playerEvent.ts:18-45` | 只在 `playerLoadstart` 启动；卡死期间没有 `loadstart` |
| 延迟切歌 5s | `playerEvent.ts:59-70` + `addDelayNextTimeout` | 只在 `playerError` 之后启动；期间没有任何 error |
| `PLAYBACK_SILENT`（"在播但不前进"） | `utils/playbackHeartbeat.ts:246` | 判据里要求 `base.isPlay`，而 1.5 的 `app_event.pause()` 每 0.58s 把它改成 false，`silentSince` 被反复重置（且它只写日志、不做恢复） |
| 原生 `SILENT_PLAYBACK` | `android/.../diagnostics` | 要求连续 15s 都是 `tpState=PLAYING`；本次状态在 3/6 之间跳，计时器一直复位（所以只有 13:55:52 那次类似情况被记录，`L1730`） |

结果：`position` 冻住以后**没有任何代码会去救**，只能用户手动切歌（切回来还会再卡）。

## 3. 根因与边界（如实标注推断）

**已证实的机制**：

1. 该 FLAC 播到 277.4s 时，原生音频输出进入「AudioTrack 释放 → BUFFERING → 重建 → PLAYING」的无限循环；
2. `position` 因此冻结（音频时间戳不再推进），`buffered` 正常；
3. 重新 prepare/seek 到同一位置必现（判据跟着媒体数据走）；
4. App 没有任何检测/恢复路径，UI 还把缓冲当暂停，进一步掩盖了现场。

**尚未证实的部分**：为什么恰好是这一帧。两种可能，这份日志无法区分：

- (a) 文件在该位置附近有坏帧/非常规帧（下载来源是 `_EM.flac`，本地库 7000+ 首混有 OGG/FLAC/MP3），
  FLAC 解析器反复重同步/重配音频轨；
- (b) 该机型（小米 25102RKBEC）的**音频卸载 / gapless** 路径在特定帧边界重建 AudioTrack。
  App 设置项文案本身就写过这类系统 bug（`setting_play_audio_offload_tip`：「某些设备……无法完整播放整首歌」），
  而本次现场正是「无法完整播放整首歌」＋ AudioTrack 反复重建。

要定论，需要在 fork 里开启**已经写好但被注释掉的** `EventLogger`（`node_modules/react-native-track-player/.../MusicManager.java:169`
`// player.addAnalyticsListener(new EventLogger(null));`），卡死时抓 logcat：
`audioSinkConfigure` / `audioTrackInit` / `audioTrackReleased` / `onAudioInputFormatChanged` 会直接给出是「格式变化」还是「卸载回退」。

## 4. 修复

### 4.1 缓冲不再伪装成暂停（`src/plugins/player/service.ts`）

`TPState.Buffering` 只调用 `playerWaiting()`（写「缓冲中」），不再 `app_event.pause()`。
缓冲期间 UI 仍是"播放中"、进度轮询不中断，不会再每秒闪一次暂停/播放，也不会把卡死检测的重置定时器一直复位。

### 4.2 新增「原生 position 不前进」看门狗（`src/utils/playbackStallGuard.ts`，启动于 `src/app.ts`）

- 用 `react-native-background-timer`（原生定时器，息屏/后台也触发）每 2s 采样 `getState()` + `getPosition()`；
- 仅当「UI 认为在播放、原生状态是 Playing/Buffering、且不是临时轨/取链接中/已停止」时才判定
  （暂停、结束、Connecting 一律不判，避免误伤正常流程）；
- `position` 连续 10s 不前进（容差 0.05s）→ 判为卡死：
  1. 先 `app_event.setProgress(position + 5s)`：一次 seek 会让 ExoPlayer flush 并重建 AudioTrack，
     多数「卡在某一帧」的情况会在这一步恢复，且不切歌（走既有 `setProgress → setCurrentTime` 通道）；
  2. 再等 12s 仍不前进 → `playNext(true)` 跳过这首，避免用户永久干等；
- 每次判定/恢复都写 `[PLAYBACK_STALL]` 错误日志 + `markEvent`，并带 `audioOffload` 设置值，
  下次复现可直接对照是不是音频卸载相关；
- 诊断导出新增 `[PLAYBACK_STALL_GUARD]` 段（`src/utils/diagnostics.ts`），可见判定次数与最近一次恢复动作。

### 4.3 修掉 `PLAYBACK_SILENT` 的失效判据（`src/utils/playbackHeartbeat.ts`）

去掉 `base.isPlay` 前置条件，只看「原生状态是 Playing/Buffering 且 position 没前进」，
避免再次因为「缓冲=暂停」而把最关键的证据吞掉。

## 5. 验证

| 检查 | 结果 |
| --- | --- |
| `npm run tsc` | 通过（exit 0） |
| `npm run lint`（全量） | 通过（exit 0） |
| `npm run build-test`（Metro bundle） | 通过（bundle 写入成功，新增模块正常解析） |
| 真机 / `gradlew assembleDebug` | **未跑**（本次只改 JS/TS，原生未改动；需真机验证恢复策略） |

## 6. 真机验证建议（下次复现）

1. 播同一首到 04:37，确认出现 `[PLAYBACK_STALL] native player position stopped advancing`，
   随后要么 `recovery: seek forward ...` 后继续播放（进度跳到 04:42 附近），要么 `skip to next track`；
2. 关闭「音频卸载」完全重启后再播同一段：若不再卡死 → 与该机型的 offload/gapless 路径相关，
   可考虑对不支持的设备/格式自动降级（目前只在设置说明里提示用户手动关）；
3. 把该 FLAC 拷到 PC 用 `flac -t` / `ffmpeg -v error -i <file> -f null -` 解码一遍，
   确认 277s 附近是否有坏帧 —— 这能直接区分 (a)/(b) 两种可能；
4. 若要一步定位原生侧，按 §3 打开 `EventLogger` 抓 logcat。

## 7. 残留风险

- 恢复策略是**兜底**不是根因修复：根治取决于 §3 的 (a)/(b) 结论；
- `seek +5s` 在真卡死时会让用户丢掉几秒音频（可接受，但属于行为变化）；
- 若设备音频路径整体坏掉（所有歌都卡），会表现为「每 ~22s 自动跳一首」；连续跳歌达到 3 首后
  自动退化成「只 seek 不跳歌」，不会把整个歌单跳完；
- 原生 `SILENT_PLAYBACK` 检测器仍要求连续 PLAYING，本次这种 3/6 抖动它抓不到；
  目前靠 JS 侧看门狗兜底，后续可考虑在原生侧按「position 长时间不变」判定。
