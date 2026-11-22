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
- 当前主要调用者：同步认证（`plugins/sync/client/auth.ts`）、在线歌词匹配（`core/mediaMatch/`）、
  在线封面匹配（`core/coverMatch/`，`binary: true` 取图）、诊断/日志上报（若有）

### 1.1 在线歌词匹配（`src/core/mediaMatch/`）

- 两段式 provider：`search(query, signal)` 只返回候选元数据；`getLyric(candidate, signal)` 按需取词，
  取词后校验（时间标签/长度/占位文本），无效返回 `null`；netease 的取词结果额外带行级中文翻译/罗马音。
- 三源**并行**（`Promise.all`）+ 单源预算 8s（到点只 abort 该源，父信号 = 整体兜底 12s 或弹窗关闭）；
  源内部请求仍串行、间隔 ≥250–300ms。
- 失败语义：聚合结果非空即返回；候选为空且 ≥1 个源失败/超时 → 抛错（UI 显示可重试）；只有全部源都成功且
  都 0 条时才返回空结果（「没匹配到」）。
- LRCLIB：
  - 搜索 `GET https://lrclib.net/api/search?track_name=&artist_name=&album_name=`，0 条时回退 `?q=`；
  - 取词 `GET https://lrclib.net/api/get/{id}`；
  - 必须带 `User-Agent: LXMusicLocal/<version> (...)`、`Accept: application/json`；
  - 429/503 按 `Retry-After` + ≤30% 抖动退避，最多 2 次；响应上限 2MB。
- QQ（实验性，非官方）：
  - 搜索 `GET https://c.y.qq.com/soso/fcgi-bin/client_search_cp?format=json&n=10&p=1&w=<kw>&cr=1&g_tk=5381`；
  - 歌词 `GET https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=<mid>&format=json&nobase64=1&g_tk=5381`，
    **必须带 `Referer: https://y.qq.com/`**；
  - HTTP 恒 200、Content-Type 为 text/html，但 body 是 JSON → `res.text()` + `JSON.parse`；
  - 不带任何登录 Cookie；`code!==0`/占位文本/无有效歌词按失败处理。
- 网易云（第三方非官方、无 key）：
  - 搜索 `GET https://music.163.com/api/search/get/web?csrf_token=&s=<kw>&type=1&offset=0&limit=10`；
  - 取词 `GET https://music.163.com/api/song/lyric?id=<id>&lv=-1&kv=-1&tv=-1&rv=-1`；
  - `tlyric.lyric` → 中文翻译、`romalrc`（回退 `yromalrc`）→ 罗马音；只保留时间轴行（去 `//`/元信息），
    无主歌词/`nolyric`/`uncollected`/`code!==200` → 降级；
  - 必须带桌面 UA + `Referer: https://music.163.com/`、不发送 Cookie；串行 ≥300ms、10s 超时、4MB 上限。
- 应用写盘：主歌词 + 可选扩展段 `[awlrc:lrc:<b64>,tlrc:<b64>,rlrc:<b64>]` 写入同名 `.lrc`（不写音频）；
  无翻译/罗马音时输出与旧版一致。
- 隐私：只发送歌名/歌手/专辑/时长（关键字由文件名解析结果生成），不发送文件路径；日志不打印歌词正文。
- 接口细节与实测证据：仓库根 `docs/online-lyrics-match-design.md` §3、`docs/source/qq-provider.md`、
  `docs/phase4-handoff.md`。

### 1.2 一键补全缺失歌词/封面（`src/core/batchMatch/`）

- 契约：仓库根 `docs/phase6-batch-match-design.md`（与桌面端共用；本节只记移动端落点）。
- 入口：当前列表顶部栏（`screens/Home/Views/Mylist/MusicList/ActiveList.tsx`）搜索按钮旁的「补全」
  （`batch_match__btn_short`）；`MusicList/index.tsx` 先按 `batch_match__confirm` 确认（{total} 为当前列表本地歌曲数），
  再打开 `components/BatchMatchModal/`。列表为空或没有本地歌曲时只提示 `batch_match__no_local`，不发请求。
- 文件状态：`utils/batchMatch/state.ts` 的 `getLocalMusicFileState(filePath)` →
  `{ fileExists, hasEmbeddedLyric, hasSidecarLyric, hasEmbeddedCover, hasSidecarCover }`。
  - 同目录歌词：`.lrc` / `.LRC`，`existsFile` + `stat` 且 `size > 0`（0 字节按缺失）；
  - 同目录封面：`utils/coverFile.getCoverImagePathIfExists`（jpg→png）+ 0 字节判断；
  - 内嵌歌词/封面：**仅当对应独立文件缺失时**才调用 `readEmbeddedLyric` / `readPic`
    （`readPic` 返回缓存路径，空串/抛错 = 无内嵌）；音频文件不存在时直接返回全 false（不计入搜索）。
  - `getMissingKinds(state)`：只有「无内嵌 **且** 无独立文件」才算缺失。
- 批次编排（`core/batchMatch/index.ts`，不依赖 React）：
  - `getListMusics(listId)` → 只保留 `source === 'local'`；逐首探测状态，缺失项才进入待处理列表；
  - 路径不可写（`checkLrcMatchablePath` / `checkCoverMatchablePath` 非 `ok`）与本地文件不存在一样计 `skipped`，
    不进入搜索/下载；非本地歌曲直接忽略、不计失败；
  - 逐首串行、先歌词后封面、每首之间默认 200ms（`intervalMs` 可注入）；单曲异常 catch 后计 `failed` 并继续；
  - 歌词：`searchLyrics` → 按排序第 1 个候选 `getCandidateLyric`，无效/失败沿排序最多再试 4 个
    `!instrumental && score >= 0.6`；成功后 `applyLrcToMusic` + `updateMusicLyricSource({ source: 'lrc' })`；
  - 封面：`searchCoverCandidates` → 前 3 个候选依次 `applyCoverCandidate`，首个成功后 `refreshPlayingCover`；
  - 取消：外部 `AbortSignal` 在每首开始、歌词/封面阶段之间、每次尝试前检查，并透传给搜索请求；
    取消后不再开始新歌曲，保留已完成结果；
  - 返回/进度：`BatchMatchResult { canceled, localTotal, total, processed, lyric, cover, failed, skipped }`，
    `onProgress` 区分 `scanning`（分母 = 本地歌曲数）与 `matching`（分母 = 待处理歌曲数）。
- 结束提示：`batch_match__summary`（toast/tipDialog）、`batch_match__none`、`batch_match__canceled`
  （附已处理首数）；三语文案在 `src/lang/{zh-cn,zh-tw,en-us}.json`。
- 已知取舍：取消不能中断已发出的网络请求（单源 8s / 整体 12s），最多等当前请求结束；
  只新增同名文件，不覆盖/删除既有独立文件（备份/原子写沿用 `utils/lrcFile.ts`、`utils/coverFile.ts`）。

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

手机端**只实现这张表**（被 PC 调用的一方）：同步由 PC 端发起，`scope` 也由 PC 传入，
因此手机端没有 compare/apply、变更清单 UI 与同步基线（这些留在桌面端）。

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

> 在线能力相关的 `@music_url__`、`@music_other_source__` 键已从 `storageDataPrefix` 删除，
> 对应的读写/清理函数（`getMusicUrl`/`getOtherSource` 等）与「资源缓存」设置页也已移除；
> 旧版本遗留的这些键不再被读写，也不会自动清理（如需清空可手动清除应用数据）。

## 5. 后续联网能力

- 在线歌词匹配（已实现）：见 §1.1 与 `core/mediaMatch/`、`utils/lrcFile.ts`、`utils/mediaMatch/`；
  结果写同名外挂 `.lrc`（不写音频标签），单曲来源偏好写在 `musicInfo.meta.lyricSource`。
- 封面匹配（已实现）：见 `core/coverMatch/`、`utils/coverFile.ts`、`utils/coverMatch/{score,image}.ts`、
  `components/CoverMatchModal/`、`utils/localPathCheck.ts`。
  - QQ（主源）：复用 `client_search_cp`（n=10）取 `albummid` → `https://y.qq.com/music/photo_new/T002R{500,150}x…M000<albummid>.jpg`；
    下载必须 `Accept: image/jpeg,image/png`（否则可能返回 webp），并用 albummid 重建 URL 做白名单校验。
  - iTunes（回退源）：`GET https://itunes.apple.com/search?term=&entity=song&limit=15&country=<jp|us>`（CJK→jp，0 结果换另一 store），
    `artworkUrl100` 的 `100x100bb`→`600x600bb`；仅接受 `https://*.mzstatic.com/image/thumb/…`。
  - 两源并行（allSettled，单源失败降级）、统一评分/专辑维度去重/≤20 条；下载 10s 超时、≤8MB、Content-Type + magic 双校验、失败重试 1 次。
  - 结果写歌曲**同目录同名** `.jpg/.png`（不写音频标签、不改音频），旧图备份 `.bak`（只留第一次）、`.tmp`+rename 原子写；
    读取链路优先同名图并带 `?v=<mtime>` 击穿图片缓存；应用/回退后刷新当前播放封面（不打断播放）。
  - 只支持真实文件系统路径；`content://`、App 缓存/私有目录入口拦截提示，不做 SAF 写回。
- 一键补全（已实现）：见 §1.2 与 `core/batchMatch/`、`utils/batchMatch/state.ts`、`components/BatchMatchModal/`；
  作用于**当前列表**的本地歌曲，只补「内嵌与同名独立文件都缺失」的歌词/封面，串行 + 可取消 + 汇总计数。
- 不要把旧的 `core/music/online.ts` 结构复活。
