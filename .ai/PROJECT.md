# PROJECT — LX Music Mobile（纯本地播放器分支）

> 知识库入口。路径相对仓库根目录（`lx-music-mobile/`）。配套：`ARCHITECTURE.md`、`MODULES.md`、
> `DATA_FLOW.md`、`API.md`、`RISKS.md`、`DEVELOPMENT.md`。

## 这是什么

`lx-music-mobile` 是本仓库的分支版本，已从上游「在线音乐聚合播放器」精简为 **纯本地音乐播放器**：

- 播放手机上的本地音频（mp3 / flac / ogg / oga / wav / m4a），读取内嵌/同名歌词与封面
- 「我的列表」（试听列表、我的收藏、自定义列表）、文件夹/文件导入、导入导出 `.lxmc`
- 播放详情页（歌词滚动、封面、变速/音量）、横竖屏两套布局、桌面歌词（Android 悬浮窗）
- 文件管理器「用其他应用打开」音频 → 直接播放（`file://` / `content://`）
- 与 `lx-music-desktop` 的跨端同步：列表 / 不喜欢列表 / **本地音乐文件同步（musicFile）**
- 诊断日志体系（`utils/log.ts`、`runtimeLog`、`bootLog`、`stallWatchdog`、`playbackHeartbeat`）

**已移除**（不要找回）：在线音源（kw/kg/tx/wy/mg）、搜索、排行榜、在线歌单与歌单详情、评论、
自定义音源 userApi（JS + 原生 QuickJS 桥 + Android 包）、版本检查/更新弹窗、内置下载、
`lxmusic://` 分享协议、换源/音质切换。

## 技术栈

| 关注点 | 技术 |
| --- | --- |
| 语言 | TypeScript 为主（`src/**` 基本全 TS/TSX），少量历史 `.js`（`request.js`、主题、hooks） |
| UI | React 18.2 + **React Native 0.73.11** |
| 导航 | `react-native-navigation` 7.39.2（原生栈，**不是** react-navigation） |
| 状态 | 自定义单例 store（module singleton + action + hook），**没有 Redux**（`store/Provider` 只剩 Theme context） |
| 事件 | 自研 `Event` 发射器（`src/event/Event.ts`），全局 `state_event` / `app_event` / `list_event` / `dislike_event` |
| 音频 | `react-native-track-player`（fork，`src/plugins/player/`） |
| 持久化 | `@react-native-async-storage/async-storage`（分块 K/V，`plugins/storage`）+ `react-native-fs` / `react-native-file-system` |
| 同步 | HTTP 认证 + WebSocket `message2call` RPC（连接用户自建的 PC 端服务） |
| 原生模块 | Android Java：`crypto`、`cache`、`lyric`、`utils`、`diagnostics` |
| 构建 | Gradle（Android）+ Metro/Babel（`@` → `./src`） |

## 平台

- **Android 5+**（minSdk 21，targetSdk 29，compileSdk 36）。唯一支持平台。
- `ios/` 目录存在但不维护；Android 专属能力（悬浮窗、文件系统、原生模块）在 iOS 不可用。视为不支持。

## 入口与启动

- `index.js`（根）→ `./shim` → `./src/app.ts`
- `src/app.ts`：
  1. `config/globalData.ts` 建立 `global.lx` 与事件枢纽，读取字号/窗口尺寸
  2. `navigation/regLaunchedEvent.ts` 监听原生启动事件
  3. 启动时 `core/init/index.ts` 顺序初始化：setting → theme → i18n → 本地媒体 → player service →
     player → 数据 → common state → sync → deeplink，然后 `navigations.pushHomeScreen()`

## 主要目录

```
src/
├─ app.ts                  # 引导入口
├─ config/                 # 设置模型/默认值、常量、迁移、globalData
├─ core/                   # 业务逻辑（不含 React）
│  ├─ music/               # index / local / utils（本地播放资源分发）
│  ├─ player/              # player playInfo progress playedList tempPlayList volume ...
│  ├─ init/                # 顺序初始化（common/dataInit/i18n/theme/sync/player/deeplink）
│  ├─ list.ts lyric.ts dislikeList.ts sync.ts desktopLyric.ts common.ts theme.ts
├─ store/                  # 单例状态 + action + hook（list/player/setting/sync/common/dislikeList/theme/Provider）
├─ event/                  # Event 基类 + state/app/list/dislike 事件
├─ plugins/                # player（TrackPlayer 封装）、sync（客户端）、storage（AsyncStorage）
├─ navigation/             # RNN 配置、屏幕注册、push helper、启动事件
├─ screens/                # Home（Vertical/Horizontal/Views）、PlayDetail
├─ components/             # player/PlayerBar、common、MetadataEditModal、MusicAddModal、MusicMultiAddModal、SearchTipList
├─ utils/                  # data/fs/request/log/诊断、localMediaMetadata、listManage、nativeModules、hooks、simplify-chinese
├─ lang/                   # zh-cn / zh-tw / en-us + i18n 运行时
├─ theme/                  # 颜色/主题定义（`npm run build:theme` 生成）
└─ types/                  # 全局 LX.* 类型声明
android/                   # Gradle 工程 + Java 原生模块（userApi 已删除）
doc/ docs/                 # 设计文档
```

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | `react-native run-android --active-arch-only`（构建+安装到设备） |
| `npm start` / `npm run sc` | Metro / 重置缓存 |
| `npm run lint` / `lint:fix` | ESLint |
| `npm run tsc`（= `typecheck`） | `tsc --noEmit` |
| `npm run build-test` | Metro 打包校验（CI 用） |
| `npm run pack:android` | `cd android && gradlew.bat assembleRelease` |
| `npm run pack:android:debug` | `gradlew.bat assembleDebug`（改原生代码后用它验证） |

## 相关项目

- 桌面端：`../lx-music-desktop`（同一 fork 思路；同步服务端在桌面端实现）
- 上游：`https://github.com/lyswhut/lx-music-mobile`（Apache-2.0）

## 给 agent 的硬规则

- **不要重新引入在线音源/下载/用户脚本**：精简是刻意目标。需要联网能力时只做独立小模块
  （在线歌词/封面匹配），复用 `utils/request.js` 与现有歌词缓存。
- 改原生代码（android/）后必须 `gradlew.bat assembleDebug` 验证；只跑 tsc/lint 不够。
- 交付前：`npm run tsc` + `npm run lint` + `npm run build-test`（改了原生再加 `assembleDebug`）。
