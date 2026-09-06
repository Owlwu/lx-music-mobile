# API

This app is a **client**, not a server. "API" here means: (a) the per-platform music source adapters, (b) the HTTP layer, (c) the optional self-hosted sync server, and (d) the user-supplied "custom source" scripts. There are no public HTTP endpoints exposed by this app (the sync feature *connects to* a user's own server).

## 1. Music source adapters (`src/utils/musicSdk/`)
Registry: `src/utils/musicSdk/index.js` → `sources` = `kw`(Kuwo), `kg`(Kugou), `tx`(QQ Music), `wy`(NetEase), `mg`(Migu), plus `xm` (stub, excluded from search). `bd` (Baidu) exists on disk but is commented out.

Each source exports a consistent interface:
| Field | Purpose | Impl |
| --- | --- | --- |
| `musicSearch.search(query, page, limit)` | music search | source endpoint |
| `tipSearch` | suggest/keyword tips | source endpoint |
| `leaderboard` | charts | source endpoint |
| `hotSearch` | hot searches | source endpoint |
| `songList` | online playlists (`getList/getListDetail/...`) | source endpoint |
| `comment` | song comments | source endpoint |
| `getLyric(songInfo)` | lyric text | source endpoint (+ local decode, e.g. `kw/decodeLyric.js`) |
| `getPic(songInfo)` | cover | source endpoint |
| `getMusicUrl(songInfo, type)` | **playable audio URL** | **delegates to `apis('<source>')`** |
| `handleMusicInfo(songInfo)` | enrich name/singer/img/album | source endpoint |
| `getMusicDetailPageUrl(songInfo)` | browser deeplink | source-specific |

Helpers at registry level: `init()` (per-source warmup), `searchMusic({name,singer,source,limit})` (fan-out to all other sources), `findMusic(musicInfo)` (cross-source matching/ranking for "toggle source").

### Important: where the audio URL comes from
`getMusicUrl` for a built-in source calls `apis('<sourceId>')` (`src/utils/musicSdk/api-source.js`):
```
apis(source):
  if common.apiSource starts with 'user_api' -> global.lx.apis[source]   # custom source
  else apiList['<apiSource>_api_<source>']   # built-in api map — EMPTY in this build
  else throw 'Api is not found'
```
- `apiList` and `apiSourceInfo` are **empty** in the shipped mobile build (all built-in `api-*` modules are commented out).
- Consequence: search / lyric / pic / songlist / charts work from the built-in adapters, but **resolving an online track to a playable URL requires a User API (custom source)** to be enabled. Without one, online playback has no URL. `[待确认: whether a default api-source is expected to be added]`
- `supportQuality[source]` = `api.supportQualitys` (empty when no api-source).

## 2. HTTP layer
- Client: `src/utils/request.js` → `httpFetch(url, options)` → `{ promise, cancelHttp() }`; `httpGet(url, headers, timeout)`; `checkUrl`.
  - Built on `global.fetch` + `AbortController` (cancellation) + `BackgroundTimer` timeout.
  - Handles gzip/deflate bodies and maps failures to `src/utils/message.ts` `requestMsg` codes: `timeout`, `notConnectNetwork`, `tooManyRequests` (403/429), `cancelRequest`, `requestError`, `httpFetchError`, etc.
- Used by: all musicSdk sources, user-api bridge, version check (`core/version.ts`), sync auth.
- Default headers/timeout: `src/utils/musicSdk/options.js`.
- No auth tokens are stored in code; source requests use ad-hoc headers per endpoint. `[待确认: per-source token refresh details]`

## 3. User API / custom source (`src/core/userApi.ts`, `src/utils/nativeModules/userApi.ts`)
- User writes/imports a JS **script** (stored under AsyncStorage keys `@user_api__` / `@user_api__<id>`) that implements `getMusicUrl`/`getLyric`/`getPic` for one or more sources.
- The script runs **natively** in a QuickJS engine (Android `userApi/QuickJS.java`) on a dedicated thread; JS↔app communication is a `sendAction`/`onScriptAction` message bridge.
- On enable (`core/init/userApi/`), the app builds `global.lx.apis[source] = { getMusicUrl, getLyric, getPic, ... }`. The script calls app `request(...)` (e.g. `request.http`/`request.lyric`); the app answers via `response(...)` with a 20s timeout.
- `core/apiSource.setApiSource('user_api_<id>')` activates it (see `apis()` above).
- No API keys/credentials are bundled in the repo (scripts are user-provided at runtime).

## 4. Sync server (optional, user-hosted)
- Client: `src/plugins/sync/` (`client/index.ts`, `modules/list`, `modules/dislike`, `modules/base`, `auth.ts`).
- Transport: **HTTP** for `hello` → `id` → `auth` (credentials are AES-encrypted, server public key RSA-wrapped), then **WebSocket** for the RPC loop using `message2call` (`src/plugins/sync/utils.ts`).
- Endpoint: user-configured host + port (`storageDataPrefix.syncHost`/`syncPort`), persisted host history. **No default/built-in server.**
- Syncs only the `list` and `dislike` features (per `common.syncEnabled` + `common.syncList`/`common.syncDislike`), in `manual` or `realTime` mode (`common.syncMode`). Play history is **not** synced.
- The server implementation itself is **not in this repo** (separate project). `[待确认: sync server repo / protocol version]`

## 5. Android auto-update
- `src/core/version.ts` checks a remote manifest (version code) and surfaces an update prompt; actual download/install handled by the update flow. `[待确认: update manifest URL/keys]`

## 6. Native module bridge (JS → Java)
Bridges in `src/utils/nativeModules/` → Android Java under `cn/toside/music/mobile/`:
- `crypto.ts` → `crypto/` (AES/MD5/RSA).
- `userApi.ts` → `userApi/` (QuickJS).
- `cache.ts` → `cache/` (media cache dir).
- `lyricDesktop.ts` → `lyric/` (desktop-lyric floating window).
- `utils.ts` → `utils/` (exitApp, app lifecycle, etc.).

## Cross-references
- How search/play flows use these: `DATA_FLOW.md`
- Module locations: `MODULES.md`
- Fragile areas (source breakage, user-api, sync, native): `RISKS.md`
