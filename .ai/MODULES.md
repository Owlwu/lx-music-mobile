# MODULES

Legend: **[CORE]** = core to app behavior; **[HIGH-COUPLE]** = high fan-in, many depend on it — changes ripple widely.

## Top-level module map
| Module | Path | One-line responsibility |
| --- | --- | --- |
| Bootstrap | `src/app.ts`, `index.js`, `shim.js` | App startup & init orchestration |
| Init | `src/core/init/` | Ordered startup (setting→theme→i18n→userApi→player→data→sync) |
| Config | `src/config/` | Setting model, defaults, constants, `global.lx` runtime object |
| Store | `src/store/` | Per-domain singleton state + actions + hooks |
| Events | `src/event/` | Emitter base + state/app/list/dislike hubs |
| Navigation | `src/navigation/` | react-native-navigation registry & push helpers |
| Screens | `src/screens/` | 4 React screens |
| Components | `src/components/` | Reusable UI incl. PlayerBar |
| Core: Player | `src/core/player/` | **[CORE][HIGH-COUPLE]** Playback controller |
| Core: Music | `src/core/music/` | **[CORE]** Resolve URL/pic/lyric for online/local/download |
| Core: Search | `src/core/search/` | **[CORE]** Music & songlist search |
| Core: List | `src/core/list.ts` | **[CORE]** My-lists CRUD |
| Core: Songlist | `src/core/songlist.ts` | Online playlist browser |
| Core: Sync | `src/core/sync.ts` + `src/plugins/sync/` | Device↔server list/dislike sync |
| Core: User API | `src/core/userApi.ts` + `core/init/userApi/` | Custom-source script runtime |
| Core: API source | `src/core/apiSource.ts` | Select active source (built-in vs user api) |
| Music SDK | `src/utils/musicSdk/` | **[CORE][HIGH-COUPLE]** Per-source request/response modules |
| Request | `src/utils/request.js` | **[HIGH-COUPLE]** HTTP client (fetch wrapper) |
| Data (persist) | `src/utils/data.ts` | **[HIGH-COUPLE]** AsyncStorage read/write for all app data |
| Storage | `src/plugins/storage.ts` | AsyncStorage wrapper (chunking) |
| Player plugin | `src/plugins/player/` | **[CORE][HIGH-COUPLE]** TrackPlayer wrapper + playback service |
| FS | `src/utils/fs.ts` | Filesystem (files, gzip, SAF) |
| Native bridges | `src/utils/nativeModules/` | Wraps Android Java modules |
| Theme | `src/theme/` + `store/theme/` | Theme definitions + active theme state |
| i18n | `src/lang/` | Locale JSON + runtime |
| Types | `src/types/*.d.ts` | Ambient `LX.*` namespace |

---

## Detailed modules

### Bootstrap — `src/app.ts`
- Entry after `index.js`. Sets `global.lx`, loads font size + `windowSizeTools`, waits for native launch, then runs `core/init` and pushes Home.
- Depends: `core/init`, `navigation`, `config/globalData`, `utils/*`.
- Note: init failure shows a `tipDialog` then `exitApp()`.

### Init — `src/core/init/index.ts`
- Ordered async init: `initSetting → initTheme → initI18n → initUserApi → setApiSource → registerPlaybackService → initPlayer → dataInit → initCommonState → initSync`. Returns `handlePushedHomeScreen`.
- Sub-inits in `init/player/`, `init/userApi/`, `init/deeplink/`.
- **Note**: order matters (e.g. apiSource must be set before player/data). Don't reorder casually.

### Config — `src/config/`
- `constant.ts` **[HIGH-COUPLE]**: `storageDataPrefix` (all AsyncStorage keys), `LIST_IDS`, `COMPONENT_IDS`, `NAV_SHEAR_NATIVE_IDS`, `NAV_MENUS`, `MUSIC_TOGGLE_MODE`, `DEFAULT_SETTING`.
- `defaultSetting.ts`, `setting.ts` (load/migrate + persist the `LX.AppSetting`), `migrate*.ts` (old→new key migration), `globalData.ts` (creates `global.lx` + event hubs at import time).
- **Note**: `globalData.ts` runs on import; the event hubs and `global.lx` must exist before anything uses them.

### Store — `src/store/`
Pattern (see ARCHITECTURE.md): `state.ts` (singleton), `action.ts` (mutate+emit), `hook.ts` (subscribe). Domains: `setting`, `player`, `list`, `search`, `theme`, `sync`, `version`, `common`, `dislikeList`, `userApi`, `hotSearch`, `leaderboard`, `songlist`.
- `Provider/index.ts` → `ThemeProvider.tsx` (only a **Theme** context provider; wraps every screen in `registerScreens.tsx` via `WrappedComponent`).
- `store/index.ts` is essentially empty (a vestigial `useGetter`).
- **[HIGH-COUPLE]**: `setting` and `player` state are read from nearly everywhere.

### Events — `src/event/`
- `Event.ts` — base emitter (`on/off/emit/offAll`), `emit` is async via `setImmediate`.
- `stateEvent.ts` **[HIGH-COUPLE]** — `StateEvent` with all typed state-change events (`configUpdated`, `playStateChanged`, `playProgressChanged`, `mylistUpdated`, etc.).
- `appEvent.ts`, `listEvent.ts` (list CRUD + sync bridge), `dislikeEvent.ts`.
- Hubs exposed as globals: `global.state_event`, `global.app_event`, `global.list_event`, `global.dislike_event`.

### Navigation — `src/navigation/`
- `index.ts`: `init()` registers screens + sets up popped-listener + defers to `onAppLaunched`.
- `registerScreens.tsx`: registers `Home/PlayDetail/SonglistDetail/Comment` + `VersionModal/PactModal/SyncModeModal`, each wrapped in `<Provider>`.
- `navigation.ts`: `pushHomeScreen`, `pushPlayDetailScreen`, `pushSonglistDetailScreen`, `pushCommentScreen` (with shared-element/transition animations).
- `screenNames.ts`: native component name constants (`lxm.HomeScreen`, ...).
- `regLaunchedEvent.ts`, `event.ts`, `hooks.ts`, `utils.ts`.
- Screen names & component ids: `config/constant.ts` (`COMPONENT_IDS`).

### Screens — `src/screens/`
- `Home` (`index.tsx`): the main hub. Picks `Vertical/` or `Horizontal/` layout by `useHorizontalMode`. Registers `COMPONENT_IDS.home`. Contains the nav views under `Home/Views/`: `Search`, `SongList`, `Leaderboard`, `Mylist`, `Setting`, `Download`.
- `PlayDetail`: full player screen (big art, lyric, controls).
- `SonglistDetail`: online playlist detail.
- `Comment`: song comments.
- `Home/Vertical/` (`Header`, `DrawerNav`, `Main`, `Content`), `Home/Horizontal/`.

### Components — `src/components/`
- `player/PlayerBar/` **[CORE]**: the persistent bottom player bar; reads `player` state + `useProgress`/`useBufferProgress`; drives `core/player` actions. Plus `Progress.tsx`, `ProgressBar.tsx`.
- `common/`: shared UI atoms.
- Modals/lists: `MetadataEditModal`, `MusicAddModal`, `OnlineList`, `SearchTipList`, `SourceSelector`, `DesktopLyricEnable`, `TimeoutExitEditModal`, `PageContent`, `SizeView`.

### Core: Player — `src/core/player/` **[CORE][HIGH-COUPLE]**
- `player.ts` (668 lines, main controller): `playList`, `playListById`, `playNext`, `playPrev`, `play`, `pause`, `stop`, `togglePlay`, `collectMusic`, `dislikeMusic`; internal `handlePlay`, `setMusicUrl`, `getMusicPlayUrl` (with retry + "too many requests" backoff), `getNextPlayMusicInfo` (respects `togglePlayMethod`: listLoop/random/list/singleLoop/none).
- `playInfo.ts`: `setPlayMusicInfo`, `setMusicInfo`, `getPlayIndex`, `getList` — writes `playerState`.
- `playStatus.ts`: `setStatusText`, play-state text.
- `progress.ts`: progress updates → `state_event.playProgressChanged`.
- `playedList.ts`, `tempPlayList.ts`: history / play-later management.
- `timeoutExit.ts`, `utils.ts` (`filterList`).
- **Consumers**: PlayerBar, PlayDetail, remote controls, `plugins/player/service.ts`.
- **Key invariant**: playback state is in `playerState` (singleton); the TrackPlayer engine state is mirrored via `app_event` (see DATA_FLOW.md "Playback").

### Core: Music — `src/core/music/` **[CORE]**
- `index.ts`: `getMusicUrl`, `getPicPath`, `getLyricInfo` — dispatch to online/local/download by musicInfo shape.
- `online.ts` / `local.ts` / `download.ts`: per-source resolution. Online uses caching (`data.getMusicUrl`/`getLyric`) and calls `musicSdk[source]`.
- `utils.ts`: `handleGetOnlineMusicUrl`, `getPlayQuality`, source-toggle fallback (`TRY_QUALITYS_LIST`), `buildLyricInfo`.
- **Consumers**: `core/player/player.ts`, songlist/detail, search, download.

### Core: Search — `src/core/search/` **[CORE]**
- `search.ts`: search text/type + history (`addHistoryWord`, `removeHistoryWord`, `clearHistoryList`).
- `music.ts`, `songlist.ts`: perform searches (fan-out across sources via `musicSdk.searchMusic`/`findMusic` or per-source).
- State: `store/search/` (music + songlist subfolders).
- **Consumers**: `screens/Home/Views/Search/*`.

### Core: List — `src/core/list.ts` **[CORE]**
- My-lists CRUD, all delegating to `global.list_event` (which persists + emits): `addListMusics`, `removeListMusics`, `moveListMusics`, `updateListMusics`, `overwriteListMusics`, `createList`, `setTempList`, etc.
- In-memory cache: `utils/listManage.ts` (`userLists`, `allMusicList` Map).
- Persist: `utils/data.ts` (`@user_list`, `@list__<id>`).
- **HIGH-COUPLE**: used by player, songlist, sync, and Mylist UI.

### Core: Songlist — `src/core/songlist.ts`
- **Online playlist browser** (distinct from local "my lists"). In-memory cache; `getList`, `getListDetail`, `getListDetailAll`, `getSortList`, `getTags`. Delegates to `musicSdk[source].songList.*`.
- `syncSourceList.ts`: refresh a user list that mirrors an online source.

### Core: Sync — `src/core/sync.ts` + `src/plugins/sync/`
- `core/sync.ts`: status/mode UI glue (`selectSyncMode`, `setSyncStatus`).
- `plugins/sync/client/`: `client.ts` (WebSocket + `message2call`), `auth.ts` (HTTP hello/id/auth, AES+RSA), `utils.ts` (encrypt/gzip), `modules/list/` + `modules/dislike/` (handshake + action mapping), `data.ts`.
- Local bridge: `plugins/sync/listEvent.ts` / `dislikeEvent.ts` read/write local lists & forward to socket.
- Constants: `plugins/sync/constants.ts` (sync codes, TRANS_MODE).
- **Note**: syncs `list` + `dislike` features only; play history is NOT synced. Server URL is user-configured (no default). See API.md + RISKS.md.

### Core: User API — `src/core/userApi.ts` + `src/core/init/userApi/`
- `userApi.ts`: import/remove/enable user-api scripts (`importUserApi`, `setUserApi`, `loadScript`).
- `init/userApi/index.ts`: runs the native QuickJS bridge, builds `global.lx.apis[source]` = `{ getMusicUrl, getLyric, getPic }`; implements the app-side `request`/`response` bridge with a 20s timeout.
- Native: `utils/nativeModules/userApi.ts` → Android `userApi/` (QuickJS engine).
- Scripts stored at `@user_api__` / `@user_api__<id>`.

### Core: API source — `src/core/apiSource.ts`
- `setApiSource(apiId)`: if `user_api_*` → `setUserApi`, else set `global.lx.qualityList` + `destroyUserApi`; persists `common.apiSource` and emits `apiSourceUpdated`.
- `utils/musicSdk/api-source.js`: `apis(source)` returns the active source's API (built-in list is empty in this build → only user-api provides online `getMusicUrl`). `api-source-info.ts` (selectable source list) is empty.

### Music SDK — `src/utils/musicSdk/` **[CORE][HIGH-COUPLE]**
- `index.js`: registry of sources + `init()`, `searchMusic()`, `findMusic()`.
- Per-source folders `kw/ kg/ tx/ wy/ mg/` (each exports the same interface: `musicSearch`, `tipSearch`, `leaderboard`, `songList`, `hotSearch`, `comment`, `getMusicUrl`, `getLyric`, `getPic`, `getMusicDetailPageUrl`). `xm.js` is a stub; `bd/` exists but is not wired in.
- `getMusicUrl` for a source delegates to `apis('<id>')` (active API source / user api) — returns `{ canceleFn, promise }`.
- `utils.js`, `options.js` (default headers/timeout), `api-source.js`, `api-source-info.ts`.
- **Note**: each source has vendor-specific crypto/endpoints (see API.md). This is leaf-ish; safe to extend per-source without touching core.

### Request — `src/utils/request.js` **[HIGH-COUPLE]**
- `httpFetch(url, options)` → `{ promise, cancelHttp() }`; `httpGet`, `checkUrl`. Built on `global.fetch` + `AbortController` + `BackgroundTimer` timeout.
- Error mapping to `utils/message.ts` `requestMsg` (`timeout`, `notConnectNetwork`, `tooManyRequests`, `cancelRequest`, ...).
- **Consumed by**: all musicSdk sources, user-api bridge, version check, sync auth.

### Data (persist) — `src/utils/data.ts` **[HIGH-COUPLE]**
- All app K/V persistence with in-memory caches + throttled writes: lists, lyric cache, music-url cache, play info, settings sub-keys, search history, sync host/auth, user-api scripts, theme, font size, dislike.
- Backed by `plugins/storage.ts` (AsyncStorage, chunks values >500KB). Keys from `config/constant.ts`.

### Player plugin — `src/plugins/player/` **[CORE][HIGH-COUPLE]**
- `index.ts`: wraps `react-native-track-player` — `initial` (setupPlayer), `isInitialized`, plus re-exports from `utils.ts` (`setResource`, `setPlay`, `setPause`, `setStop`, `setVolume`, `setPlaybackRate`, `initTrackInfo`, `isEmpty`, ...).
- `service.ts`: `registerPlaybackService` — registers TrackPlayer events (RemotePlay/Pause/Next/Prev/Stop/Seek, PlaybackError, PlaybackState, PlaybackTrackChanged) and bridges them to `global.app_event` + `core/player`.
- `hook.ts`: `usePlaybackState`, `useProgress`, `useBufferProgress`.
- `playList.ts`, `utils.ts`.
- **Circular dep note**: imports from `core/player/player.ts` (for remote next/prev). Keep it function-level.

### FS — `src/utils/fs.ts`
- `react-native-fs` + `react-native-file-system` wrapper: read/write/mkdir/unlink/stat/hash, gzip, download, Android SAF (`selectManagedFolder`, `getPersistedUriList`). Dir constants (Cache/SDCard/Document).

### Native bridges — `src/utils/nativeModules/`
- `utils.ts` (exitApp, etc.), `crypto.ts` (AES/MD5/RSA), `userApi.ts`, `cache.ts`, `lyricDesktop.ts`, `cryptoTest.ts`.
- Map 1:1 to Android Java packages under `cn/toside/music/mobile/`.

### Theme — `src/theme/` + `store/theme/`
- `theme/Colors.js`, `theme/themes/themes.ts` (built-in themes), `Typography.js`. Generated via `npm run build:theme` (`themes/createThemes.js`).
- `store/theme/state.ts` holds the active `theme` + `ThemeContext`; `ThemeProvider.tsx` provides it.

### i18n — `src/lang/`
- `zh-cn.json`, `zh-tw.json`, `en-us.json`, `i18n.ts` (`t`, `setLanguage`), `index.ts`. Keys look like `player__getting_url`.

### Types — `src/types/*.d.ts`
- Ambient global namespace `LX`: `AppSetting`, `Music`, `List`, `Player`, `Sync`, `UserApi`, `Theme`, `Quality`, `Source`. Add new shared shapes here, not ad-hoc.

## Cross-references
- How these connect at runtime: `ARCHITECTURE.md`, `DATA_FLOW.md`
- Network/source specifics: `API.md`
- Fragile areas: `RISKS.md`
