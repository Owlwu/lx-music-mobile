# DATA_FLOW — 数据怎么走

> 分场景流程。先读 `ARCHITECTURE.md`。函数/文件名为真实实现。

## 1. 本地歌曲导入

```
Home → 我的列表 → 菜单（导入文件夹 / 导入文件）
  → screens/Home/Views/Mylist/MyList/actions.ts
      · 目录选择：utils/fs.ts（SAF / 授权目录）
      · 递归扫描音频扩展名（mp3/flac/ogg/oga/wav/m4a）
  → utils/music.ts createLocalMusicInfo(path)
      · utils/localMediaMetadata.ts 解析 title/artist/album/duration/内嵌封面
      · 生成 LX.Music.MusicInfoLocal：{ id: 文件路径, source: 'local', meta: { filePath, ext, ... } }
  → store/list/action addListMusics(listId, infos) → core/list.ts
  → utils/data.ts 写 AsyncStorage（分批、chunked）
```

要点：
- **本地歌曲 `id` 就是文件路径（Android 上可能是 `content://` 或授权目录路径）**；文件被移动/删除后
  该行会失效（播放时提示文件不存在）。
- 导入后支持排序、查重、重命名列表、导入导出 `.lxmc`（`LXM_FILE_EXT_RXP`）。

## 2. 播放（核心链路）

```
UI（PlayerBar / PlayDetail / 通知栏 / 锁屏 / 耳机键）
   │
   ▼
core/player/player.ts  playList / playListById / playNext / playPrev / play / togglePlay
   │  setPlayMusicInfo(playMusicInfo, isTempPlay?)   (core/player/playInfo.ts → store/player)
   ▼
handlePlay()
  ├─ setStop(); global.app_event.pause()
  ├─ setMusicUrl(musicInfo)      → getMusicPlayUrl() → core/music.getMusicUrl()
  ├─ getPicPath(musicInfo)       → 更新封面
  └─ getLyricInfo(musicInfo)     → 更新歌词
   ▼
core/music/index.ts → core/music/local.ts
  ├─ getLocalFilePath() 命中 → file:// 或 content:// 可被 TrackPlayer 播放的 URL
  └─ 不存在 → throw '文件不存在'（按设置自动跳过或报错）
   ▼
plugins/player setResource(url) → TrackPlayer
   ▼
plugins/player/service.ts（原生播放服务回调）→ global.app_event.player*
   ▼
store/player 更新 + state_event.playStateChanged / playProgressChanged
   ▼
UI（PlayerBar / PlayDetail）重渲染；播放进度写 utils/data.ts（节流）
```

- `getNextPlayMusicInfo()` 遵循 `MUSIC_TOGGLE_MODE`（listLoop / random / list / singleLoop / none），
  包含「稍后播放」临时队列与 `playedList` 历史。
- 播放失败看门狗：`core/player/timeoutExit.ts`（超时退出播放）+ 自动跳过（设置项）。
- 通知栏/锁屏控制经 `plugins/player/service.ts` 转 `app_event`，最终调用 `core/player` 同一批函数。

## 3. 歌词与封面（本地）

| 资源 | 取法 |
| --- | --- |
| 封面 | `utils/localMediaMetadata.ts` 内嵌封面；否则同名图片文件；否则主题占位 |
| 歌词 | 内嵌歌词（ID3 USLT / FLAC LYRICS）优先；否则同名 `.lrc`；支持 `.krc`（`decodeKrc`）；`utils/lrcTools.ts` 解析；已编辑歌词存于 `@lyric__<id>`（raw/edited） |
| 桌面歌词 | `core/desktopLyric.ts` + 原生 `lyric` 悬浮窗模块 |

## 4. 列表持久化与事件

- 列表 CRUD：`store/list/action` → `core/list.ts` → `utils/listManage.ts`（内存缓存）→ `utils/data.ts`
  （AsyncStorage 键 `@list__<id>`、`@user_list` 等）。
- 变更后 `global.list_event.*` + `global.state_event.mylistUpdated` 通知 UI 与同步模块。

## 5. 同步（`list` / `dislike` / `musicFile`）

```
设置 → 同步（screens/Home/Views/Setting/settings/Sync/）
  → core/sync.ts（connectServer / disconnectServer / 状态）
  → plugins/sync/client（HTTP hello → id → auth → WebSocket RPC）
      ├─ modules/list    列表双向同步（listEvent）
      ├─ modules/dislike 不喜欢同步（dislikeEvent）
      └─ modules/musicFile 本地音乐文件同步（用户手动触发）
```

- 认证：AES + RSA（`client/auth.ts`）；服务端由桌面端提供。
- 同步状态通过 `store/sync` 暴露到设置页；连接失败只记录日志（不要重复 toast）。

### 5.1 本地音乐文件同步（`musicFile`）

```
设置 → 音乐文件同步（Sync/MusicFileSync）
  → core/musicFileSync.ts
  → plugins/sync/client/modules/musicFile/service.ts
      ├─ localFs.ts  扫描 root（scope 子目录）、分块读写、删除（含同名 .lrc）、算内容签名
      ├─ diff.ts     纯函数：变更分类 + 执行计划（与桌面端逐字节一致）
      ├─ baseline    AsyncStorage `@music_file_sync_baseline`（上次同步认同的路径）
      └─ handler.ts  对端 RPC（musicFile_* 方法）
```

- 路径相对各自 `sync.musicFile.root`、`/` 分隔，过 `assertSafeRelPath` 校验。
- 相等判定：文件大小 + 内容签名（首/尾 4 KiB 的 fnv1a32+djb2_32）；签名失败退回「仅大小」。
- 冲突默认用对端覆盖；UI 有「全部用本地/对端」批量按钮；无断点续传。
- 设计契约：`lx-music-desktop/doc/music-file-sync/本地音乐文件同步-设计.md`。

## 6. 文件管理器打开音频（deeplink）

```
Android Intent (ACTION_VIEW, file:// / content://)
  → 原生把 URL 交给 JS（启动或运行中）
  → core/init/deeplink/index.ts
      ├─ file://  → 加入列表并播放
      └─ content:// → 解析真实路径（utils/fs.ts）后同样处理
```

（`lxmusic://` 分享协议已删除，AndroidManifest 不再有该 scheme。）

## 7. 启动

`index.js` → `src/app.ts`：
1. `config/globalData.ts` 建 `global.lx` + 事件枢纽
2. 读字体大小、窗口尺寸
3. `navigation/regLaunchedEvent.ts` 等原生启动事件
4. `core/init/index.ts` 顺序初始化：
   `setting` → `theme` → `i18n` → 本地媒体 → player service → player → `dataInit` → `common` →
   `sync` → `deeplink`
5. `navigations.pushHomeScreen()`

`core/init/player/*` 负责把 `playerState`、进度、播放状态与 TrackPlayer 引擎接起来；
`core/init/dataInit.ts` 加载用户列表、上次播放、同步数据。

## 8. 退出 / 后台

- `utils/nativeModules/utils.ts`（`exitApp`、生命周期）；`react-native-background-timer` 维持重试与延迟。
- 播放服务在通知栏常驻；`playbackHeartbeat.ts` 记录播放心跳用于诊断。
