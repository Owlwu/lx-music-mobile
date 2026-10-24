# API

本应用是 **客户端**，不对外暴露 HTTP 接口。这里的「API」指：同步客户端的对端 RPC、HTTP 请求层、
原生模块桥、本地持久化键，以及后续可扩展的联网能力。

> 在线音源适配层（`utils/musicSdk/`）与自定义音源（userApi/QuickJS）已整体删除。

## 1. HTTP 请求层 —— `src/utils/request.js`

- `httpFetch(url, options)` → `{ promise, cancelHttp() }`（`fetch` + `AbortController` + 后台超时）
- `httpGet(url, options, callback)` → 返回取消函数
- 超时用 `react-native-background-timer`（默认 15s，可传 `timeout`）
- 解压：`gzip/deflate` 响应体
- 错误映射到 `src/utils/message.ts` 的 `requestMsg`：`timeout`、`notConnectNetwork`、
  `tooManyRequests`(403/429)、`cancelRequest`、`requestError`、`httpFetchError` 等
- 当前主要调用者：同步认证（`plugins/sync/client/auth.ts`）、诊断/日志上报（若有）、未来「在线歌词/封面匹配」

## 2. 同步客户端（`src/plugins/sync/`）

连接用户自建的同步服务端（由桌面端提供，不在本仓库）。

- 传输：**HTTP** `hello` → `id` → `auth`（凭据 AES 加密，服务端公钥 RSA 包裹）→ 之后升级为
  **WebSocket**，RPC 用 `message2call`（`plugins/sync/utils.ts`）
- 端点：用户配置的 host/port（`storageDataPrefix.syncHost`、`syncHostHistory` 保留历史）
- 特性协商（`plugins/sync/constants.ts` `FeaturesList`）：`list`、`dislike`、`musicFile`
- 客户端入口：`client/index.ts`（`connectServer` **失败时 reject**，调用方必须 `.catch`）；
  `client/client.ts` 负责连接与消息循环
- 子模块：`client/modules/list`、`client/modules/dislike`、`client/modules/musicFile`、`client/modules/sync`
- 桌面端对应实现：`lx-music-desktop/src/main/modules/sync/server/`（改协议要两边一起）

### 2.1 `musicFile` 对端 RPC

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `musicFile_get_root` | – | `string`（对端音乐目录） |
| `musicFile_get_index` | `scope: string[]` | 文件索引（路径/大小/签名/mtime） |
| `musicFile_read_file` | `path, offset, size` | `{ data: base64, eof }` |
| `musicFile_write_file` | `path, offset, data, isLast` | `void` |
| `musicFile_delete_file` | `path, withLyric` | `void` |
| `musicFile_sync_finished` | – | `void` |

路径相对各自 `sync.musicFile.root`、`/` 分隔、过 `assertSafeRelPath`；分块 192 KiB（base64）。

## 3. 原生模块桥（`src/utils/nativeModules/`）

| 文件 | Android 包 | 作用 |
| --- | --- | --- |
| `crypto.ts` | `crypto/` | AES/MD5/RSA（同步认证） |
| `cache.ts` | `cache/` | 媒体缓存目录 |
| `lyricDesktop.ts` | `lyric/` | 桌面歌词悬浮窗 |
| `utils.ts` | `utils/` | `exitApp`、生命周期、屏幕常亮、分享等 |
| `diagnostics.ts` | `diagnostics/` | 诊断日志/崩溃信息 |

`userApi.ts`（QuickJS）已删除；`MainApplication.java` 只注册 `cache/diagnostics/lyric/utils/crypto` 五个 Package。

## 4. 本地持久化键（`storageDataPrefix`，`config/constant.ts`）

| 键 | 内容 |
| --- | --- |
| `@list__<id>` | 列表中的歌曲 |
| `@user_list` | 用户列表元信息（id/name/位置） |
| `@list_scroll_position`、`@list_prev_select_id` | 列表滚动位置/上次选中 |
| `@lyric__<id>`、`@lyric__<id>_edited` | 歌词缓存与已编辑歌词 |
| `@music_volume__<id>` | 单曲音量调整 |
| `@play_info` | 上次播放信息 |
| `@theme`、`@font_size` | 主题与字号 |
| `@sync_auth_key`、`@sync_host`、`@sync_host_history` | 同步认证与主机配置 |
| `@music_file_sync_baseline` | 音乐文件同步基线 |
| `@open_storage_path`、`@selected_managed_folder` | 存储访问路径/托管目录 |
| `@notification_tip_enable`、`@ignoring_battery_optimization_tip_enable` | 提示开关 |
| `@cheat_tip`、`@remote_lyric_tip` | 提示状态 |
| `@dislike_list` | 不喜欢列表 |

写入统一经 `utils/data.ts`（分块 + 节流），不要直接调 AsyncStorage。

> 历史在线相关键（`@music_url__`、`@music_other_source__`）仍留在 `storageDataPrefix` 里但**无代码读写**；
> 旧数据可能残留，是否清理需谨慎（清缓存入口会按前缀删除）。

## 5. 后续联网能力（尚未实现）

规划中的「在线匹配歌词 / 封面」建议：
- 新建 `core/mediaMatch.ts` + 可选原生/JS 请求，复用 `utils/request.js`
- 结果写回：歌词用 `utils/data.ts` 的 `saveLyric/saveEditedLyric`（键 `@lyric__<id>`）；
  封面写 `musicInfo.meta.picUrl` 并 `core/list.ts listMusicUpdateInfo` 更新列表
- 不要把旧的 `core/music/online.ts` 结构复活
