# RISKS

易碎/高风险区域。改播放器、同步、原生、存储前先读这里。

## 1. 播放（最高风险）
- `src/core/player/player.ts` + `src/plugins/player/*` + `src/core/music/*` 存在**设计上的循环引用**
  （core ↔ plugin）。保持**函数级**引用，避免模块求值副作用，否则会初始化顺序崩溃。
- 两份「播放状态」必须同步：JS 侧 `playerState` 与原生 TrackPlayer 引擎状态（经 `app_event` 镜像）。
  不一致会导致 PlayerBar/PlayDetail 与实际音频脱节。
- 本地播放路径：`core/music/local.ts` 把歌曲 id（文件路径 / `content://`）转成可播放 URL；
  文件被移动或授权失效会抛「文件不存在」，需按设置自动跳过或提示，而不是崩溃。
- 自动切歌（`getNextPlayMusicInfo`）分支多（listLoop / random / list / singleLoop / none），
  注意「稍后播放」临时队列与 `playedList` 历史的下标问题。
- 遥控（通知栏/锁屏/耳机键）经 `plugins/player/service.ts` → `app_event` → core，容易重复触发。

## 2. 同步
- `src/plugins/sync/` 连接**用户自建的桌面端服务**（HTTP + WebSocket `message2call`）。协议在
  `client/modules/base/message2call.ts`、版本常量在 `plugins/sync/constants.ts`；仓库内**没有服务端实现**，
  改协议必须与桌面端一起改。
- 认证 AES + RSA（`client/auth.ts`），密钥处理不一致会静默失败。
- `connectServer()` **失败时 reject**（与桌面端 `client/index.ts` 契约一致）。所有调用点必须 `.catch`
  （启动自动连接 + 设置页开关）。未捕获的拒绝会以 LogBox 形式弹给用户；`hello` 最长可能等 10s。
  失败文案已通过 `syncStatus` 展示，调用点只应 `log.warn`，不要重复 toast。
- 同步会改本地列表（`global.list_event` / `dislike_event`）；本地编辑与远端推送的竞态可能丢/重。
- `musicFile` 会在 `sync.musicFile.root` 内**真实读写/删除文件**；入参路径一律过 `assertSafeRelPath`，
  不要绕过。
- 手机端只做被同步的一方（PC 发起、PC 传 scope），别再往手机端加「发起同步」或「选择同步文件夹」，
  否则会出现「手机端选了范围但 PC 发起时被忽略」的误导。
- `musicFile` 的相等判定是「大小 + 内容签名」（首/尾 4 KiB 的 fnv1a32+djb2_32）；签名读失败会退回
  「仅大小」，同大小内容变更可能漏检（查 `[musicFileSync][WARN][scan] signature failed` 日志）。
- 同名 `.lrc` 随音频一起搬运，不是独立条目；只改 `.lrc` 内容不会被识别为变更。
- 冲突默认用对端覆盖；无断点续传，取消会留半截文件（下次同步表现为冲突）。
- 同步基线只在发起方（`@music_file_sync_baseline` 在桌面端），手机端没有。
- `diff.ts` 与桌面端**逐字节镜像**，改一侧必须改另一侧（桌面端 `tests/music-file-fs.test.ts` 会断言）。
  因此即使手机端不再用 `buildPlan` / `buildActions` / `buildBaseline`，也**不要**从手机端 `diff.ts` 里删。

## 3. 状态 / 事件系统
- 整个 UI 响应式依赖 `global.state_event`（`setImmediate` 异步）。改了 state 不 emit = UI 不更新；
  emit 了没有订阅 = 静默无效。
- 单例按引用共享；绕过 action 直接改字段是常见 desync 来源。
- `config/globalData.ts` 在 **import 时**创建 `global.lx` 与事件枢纽；早于它执行的代码拿不到全局。

## 4. 持久化 / 存储
- `utils/data.ts` 维护内存缓存与节流写；`plugins/storage.ts` 对 >500KB 的值自动分块。
  大列表 + 频繁写会慢（注意节流）。
- 设置项有迁移路径（`config/migrateSetting.ts`、`config/migrate.ts`）。**改/删 `LX.AppSetting` 键必须写迁移**。
- 键是按 id 版本化的（`@list__<id>`、`@lyric__<id>`、`@music_volume__<id>`）；清缓存时注意前缀匹配。
- 旧在线能力遗留键：`@music_url__`、`@music_other_source__` 已从 `storageDataPrefix` 移除，
  对应读写函数与「资源缓存」设置页已删除；旧设备上的这些键仍会留在 AsyncStorage 里但无人读写。
  清缓存入口现在只处理歌词/音量等仍在使用的键，改动前先确认前缀范围。
- Android 存储访问走 `utils/fs.ts`（SAF/授权目录）；`requestStoragePermission` 流程是 Android 专属。

## 5. 精简后的残留
- **旧列表里的在线条目无法播放**：历史数据可能残留 `source != 'local'` 的歌曲。播放会提示文件不存在；
  要彻底干净需一次性清洗（先备份 AsyncStorage 数据）。
- `LX.Quality` / `LX.QualityList` / `LX.OnlineSource` / `LX.Music.MusicInfoOnline` / `LX.Download`
  等类型已全部删除；`LX.Music.MusicInfo` 就是本地歌曲（`source: 'local'`），
  `MusicInfoLocal` 仅作为等价别名保留。
- `types/list.d.ts` 里若还有 `ListUpdateInfo`/`SearchHistoryList` 等历史类型，属于遗留声明，
  新代码不要引用。

## 6. 原生 / 平台
- 自定义 Android Java 模块（`crypto`、`cache`、`lyric`、`utils`、`diagnostics`）任何 JS 侧
  `NativeModules` 调用都要做存在性守卫。
- targetSdk 29 / compileSdk 36 / minSdk 21：新系统（后台限制、分区存储）行为需实测。
- iOS 目录存在但不支持；Android 专属能力在 iOS 不可用。

## 7. 构建 / 依赖风险
- 使用 `react-native-track-player`（fork：`@chocabozu/react-native-track-player`），升级上游差异大。
- RN 0.73.11 升级成本高（原生 + Babel/Metro + presets）。
- CI 只跑 `lint` + Metro bundle，**不跑真机**；运行时回归只能人工发现。

## 8. 验证缺口
- 没有 Jest / 单测框架。门禁是 `tsc` + ESLint + `build-test`（CI）。
- 原生改动必须 `gradlew.bat assembleDebug`（或 release）验证，`tsc` 覆盖不到 Java/Gradle。
- 诊断日志：`.diagnosis/` 与 `utils/log.ts` 体系用于真机排查，出问题先看日志再改代码。

## 降风险清单
1. 先读对应 `DATA_FLOW.md` 小节
2. 尽量在单层内改动；遵守 core↔plugin 函数级引用
3. 状态：action 改 + emit；新增 hook 订阅
4. 设置键：加迁移
5. `npm run tsc` + `npm run lint` + `npm run build-test`；动原生加 `assembleDebug`；最后真机实测

## 交叉引用
- 机制：`ARCHITECTURE.md`、`DATA_FLOW.md`
- 位置：`MODULES.md`
- 构建/运行：`DEVELOPMENT.md`
