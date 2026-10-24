# MODULES — 文件都在哪

> 目录/模块地图。配合 `ARCHITECTURE.md`（怎么连）与 `DATA_FLOW.md`（怎么流）。
> 无标注的目录路径均相对 `src/`。

## 1. 引导与配置 —— `src/config/`、`src/app.ts`、`index.js`

| 路径 | 作用 |
| --- | --- |
| `index.js`（根） | 入口：`./shim` → `./src/app` |
| `src/app.ts` | 引导：同步字体/窗口尺寸、注册启动事件、`core/init` 顺序初始化、`pushHomeScreen` |
| `config/globalData.ts` | 创建 `global.lx`、`global.state_event/app_event/list_event/dislike_event`（import 时执行） |
| `config/setting.ts` | `LX.AppSetting` 模型与各分组默认值 |
| `config/defaultSetting.ts` | 默认设置（已剔除音源/搜索/下载/自定义音源/更新相关键） |
| `config/constant.ts` | `LIST_IDS`、`NAV_MENUS`（仅 `nav_love`、`nav_setting`）、`storageDataPrefix`、`DEFAULT_SETTING`（仅 `viewPrevState`）、`COMPONENT_IDS`、`MUSIC_TOGGLE_MODE`、`LXM_FILE_EXT_RXP` |
| `config/migrate.ts` | 旧数据结构迁移 |
| `config/migrateSetting.ts` | 设置项迁移（改 key / 默认值时要在这里处理） |

## 2. 业务逻辑 —— `src/core/`

| 路径 | 作用 |
| --- | --- |
| `core/player/` | 播放控制：`player.ts`（playList/playNext/playPrev/play/pause/stop/togglePlay/collectMusic）、`playInfo.ts`、`playStatus.ts`、`progress.ts`、`volume.ts`、`playedList.ts`（历史）、`tempPlayList.ts`（稍后播放）、`timeoutExit.ts`、`utils.ts`（`filterList`） |
| `core/music/` | 资源分发：`index.ts`（getMusicUrl/getPicPath/getLyricInfo）、`local.ts`（本地文件/封面/歌词）、`utils.ts`（歌词工具） |
| `core/list.ts` | 列表 CRUD（内存 + `utils/data.ts` 持久化） |
| `core/lyric.ts` | 歌词解析/行状态 |
| `core/dislikeList.ts` | 不喜欢规则（同步特性保留，入口在设置内） |
| `core/sync.ts` | 同步客户端编排（连接/断开/状态） |
| `core/musicFileSync.ts` | 本地音乐文件同步入口（转 `plugins/sync/client/modules/musicFile`） |
| `core/desktopLyric.ts` | 桌面歌词（悬浮窗）控制 |
| `core/common.ts` | 通用设置更新、`componentIds` 等 |
| `core/theme.ts` | 主题切换 |
| `core/init/` | 顺序初始化：`index.ts`、`common.ts`、`dataInit.ts`、`i18n.ts`、`theme.ts`、`sync.ts`、`player/`（多文件）、`deeplink/`（`index.ts`、`fileAction.ts`、`playerAction.ts`、`utils.js`） |

初始化顺序（`core/init/index.ts`）：setting → theme → i18n → 本地媒体 → player service → player →
data → common state → sync → deeplink。

## 3. 状态 —— `src/store/`（单例 + action + hook）

| 域 | 文件 | 说明 |
| --- | --- | --- |
| `common` | `state/action/hook` | 状态栏高度、`componentIds`、导航状态 |
| `player` | `state/action/hook` | 当前播放、音量、倍速、播放进度（含 `playbackRate`） |
| `list` | `state/action/hook` | 用户列表与列表歌曲（内存缓存） |
| `setting` | `state/action/hook` | `setting` 响应式副本（`useSettingValue`） |
| `sync` | `state/action/hook` | 同步状态、设备名、认证码 |
| `musicFileSync` | `state/action/hook` | 音乐文件同步配置/进度 |
| `dislikeList` | `state/action/hook/event/index` | 不喜欢列表 |
| `theme` | `state/action/hook` | 当前主题 + ThemeContext |
| `Provider` | `Provider.tsx`、`ThemeProvider.tsx` | 仅主题 context；`registerScreens` 用它包裹每个屏幕 |

约定：**状态只能通过 action 改，action 里 emit 事件**；hook 只读 + 订阅。
`store/index.ts` 基本为空（历史遗留 `useGetter`）。

## 4. 事件 —— `src/event/`

| 文件 | 作用 |
| --- | --- |
| `Event.ts` | 基类（`on/off/emit/offAll`，`setImmediate` 异步派发） |
| `stateEvent.ts` | **所有类型化状态事件**（`configUpdated`、`playStateChanged`、`playProgressChanged`、`mylistUpdated` 等） |
| `appEvent.ts` | 应用级事件（播放器动作、进度、音量、退出等） |
| `listEvent.ts` | 列表 CRUD + 同步桥接 |
| `dislikeEvent.ts` | 不喜欢列表 + 同步桥接 |

全局实例：`global.state_event`、`global.app_event`、`global.list_event`、`global.dislike_event`。

## 5. 插件 —— `src/plugins/`

| 路径 | 作用 |
| --- | --- |
| `player/index.ts` | TrackPlayer 初始化与 setup |
| `player/service.ts` | 播放服务（遥控/锁屏/通知事件 → `app_event`） |
| `player/playList.ts` | 播放队列同步到 TrackPlayer |
| `player/hook.ts`、`player/utils.ts` | 播放器相关 hooks/工具 |
| `sync/` | 同步客户端：`index.ts`、`client/`（`client.ts`、`auth.ts`、`utils.ts`、`modules/{list,dislike,musicFile,sync}`、`sync/`）、`constants.ts`、`data.ts`、`listEvent.ts`、`dislikeEvent.ts`、`log.ts` |
| `storage` | AsyncStorage 封装（**注意：实现为 `src/plugins/storage.ts` 而非目录**） |

`sync/client/modules/musicFile/`：`diff.ts`（与桌面端逐字节镜像）、`localFs.ts`（扫描/分块读写/签名）、
`service.ts`（驱动）、`handler.ts`（对端 RPC）、`logger.ts`。

## 6. 导航 —— `src/navigation/`

| 文件 | 作用 |
| --- | --- |
| `index.ts` | `init()`：注册屏幕、popped 监听、延迟到 `onAppLaunched` |
| `registerScreens.tsx` | 注册 `Home`、`PlayDetail`、`PactModal`、`SyncModeModal`（均包 `<Provider>`） |
| `navigation.ts` | `pushHomeScreen`、`pushPlayDetailScreen`（共享元素/转场参数） |
| `screenNames.ts` | 原生组件名常量（`lxm.HomeScreen` 等） |
| `regLaunchedEvent.ts` / `event.ts` / `hooks.ts` / `utils.ts` | 启动事件、导航事件、hooks、工具 |

## 7. 屏幕 —— `src/screens/`

| 屏幕 | 说明 |
| --- | --- |
| `Home/index.tsx` | 主界面；按 `useHorizontalMode` 选 `Vertical/` 或 `Horizontal/` |
| `Home/Vertical/` | `Header`、`DrawerNav`、`Main`（PagerView 2 页：`nav_love`、`nav_setting`）、`Content` |
| `Home/Horizontal/` | `Aside`、`Header`、`Main`、`Content` |
| `Home/Views/Mylist/` | 我的列表：`MyList/`（列表管理、导入导出、排序、重命名）、`MusicList/`（歌曲行、右键菜单、搜索、多选） |
| `Home/Views/Setting/` | 设置：`settings/{Basic,List,Player,LyricDesktop,Sync,Theme,Backup,Other}` + `settings/About.tsx` + `components/` + 横竖布局容器 |
| `PlayDetail/index.tsx` | 播放详情；`Vertical/`、`Horizontal/` 两套；`components/SettingPopup/`（歌词对齐/字号/进度、音量、倍速） |

## 8. 组件 —— `src/components/`

| 路径 | 作用 |
| --- | --- |
| `player/PlayerBar/` | 底部播放条：`Pic`、`Title`、`Progress`、`Status`、控制按钮 | 
| `common/` | 通用原子组件（`Text`、`Image`、`StatusBar`、`PageContent`、`Slider` 等） |
| `MetadataEditModal/` | 编辑歌曲元数据（标题/歌手/专辑） |
| `MusicAddModal/`、`MusicMultiAddModal/` | 把歌曲加入列表 |
| `SearchTipList/` | 列表内搜索提示（本地列表用） |

（在线列表组件 `OnlineList`、`SourceSelector` 已删除。）

## 9. 工具 —— `src/utils/`

| 文件 | 作用 |
| --- | --- |
| `data.ts` | AsyncStorage 之上的持久化门面（列表、视图状态、播放信息、同步配置…） |
| `fs.ts` | 文件系统操作（SAF/授权、目录选择、读写） |
| `request.js` | `httpFetch/httpGet`（fetch + AbortController + 后台超时；错误映射到 `message.requestMsg`） |
| `localMediaMetadata.ts` | 本地音频元数据/封面/歌词读取（原生库） |
| `music.ts` | 本地 MusicInfo 构建、`getLocalFilePath`、`decodeKrc` |
| `listManage.ts` | 列表内存缓存与操作（overwrite/add/remove/move/position…） |
| `dislikeManage.ts` | 不喜欢规则内存缓存 |
| `lrcTools.ts` | LRC 解析/格式化 |
| `log.ts` / `runtimeLog.ts` / `bootLog.ts` / `diagnostics.ts` / `stallWatchdog.ts` / `playbackHeartbeat.ts` / `errorHandle.ts` | 诊断日志体系（诊断包、异常捕获、卡顿看门狗、播放心跳） |
| `tools.ts` | 通用工具：`toast`、`formatMusicName`、`openUrl`、`exitApp`、`isAndroid` 等 |
| `nativeModules/` | `cache`、`crypto`（+ `cryptoTest`）、`diagnostics`、`lyricDesktop`、`utils` 的 JS 桥 |
| `hooks/` | `useHorizontalMode`、`useWindowSize`、`usePlayTime`、`useAnimateNumber`、`useLayout` 等 |
| `simplify-chinese-main/` | 繁简转换数据 |
| `common.ts` / `index.ts` / `message.ts` / `pixelRatio.ts` / `scroll.ts` / `windowSizeTools.ts` | 通用工具 |

> 已删除：`utils/musicSdk/`、`utils/version.js`、`utils/nativeModules/userApi.ts`、`hooks/useAssertApiSupport.js`。

## 10. 原生 —— `android/app/src/main/java/cn/toside/music/mobile/`

| 包 | 作用 |
| --- | --- |
| `crypto` | AES/MD5/RSA（同步认证、加密） |
| `cache` | 媒体缓存目录 |
| `lyric` | 桌面歌词悬浮窗 |
| `utils` | 退出应用、生命周期等 |
| `diagnostics` | 诊断日志/崩溃信息 |

`userApi/`（QuickJS）已随自定义音源删除；`build.gradle` 的 `wang.harlon.quickjs:wrapper-android`
依赖同步移除。`MainApplication.java` 只注册上述五个 Package。

## 11. 主题 / 语言 / 类型

- `src/theme/`：`Colors.js`、`themes/themes.ts`（内置主题，`npm run build:theme` 生成）、`Typography.js`
- `src/lang/`：`zh-cn.json`、`zh-tw.json`、`en-us.json`、`i18n.ts`（`t`/`setLanguage`）
- `src/types/*.d.ts`：全局 `LX` 命名空间（`AppSetting`、`Music`、`List`、`Player`、`Sync`、`Theme`、`Source`）

## 12. 其他

- `doc/`、`docs/`：设计文档（含 `docs/单曲音量调整设计方案.md`）
- `.diagnosis/`：真机诊断日志导出目录
- `scripts/`：构建辅助脚本
- `publish/`：发布相关（`npm run publish`）
