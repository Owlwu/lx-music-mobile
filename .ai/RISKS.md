# RISKS

Fragile / high-risk areas. Read this before touching player, sync, native, or storage code.

## 1. Playback (highest risk)
- `src/core/player/player.ts` + `src/plugins/player/*` + `src/core/music/*` are tightly coupled with a **circular dependency** (core↔plugin). `plugins/player/service.ts` and `index.ts` import from `core/player/player.ts`, which imports from `plugins/player`. Keep cross-imports at the **function level** (avoid module-eval side effects) or you can trigger init-order crashes.
- Two sources of "play state" must stay in sync: the JS `playerState.setPlayState` and the native TrackPlayer engine state (mirrored via `app_event`). Divergence causes the PlayerBar/PlayDetail to desync from actual audio.
- Audio URL resolution is best-effort with retry + backoff (`getMusicPlayUrl`). It depends on the active API source returning a URL; a bad/empty URL must be handled as "no playable source", not a crash.
- Auto-advance logic (`getNextPlayMusicInfo`) is case-heavy (listLoop / random / list / singleLoop / none). Off-by-one or stale-index bugs are easy.
- Remote controls (headset/lock screen) flow through `plugins/player/service.ts` → `global.app_event` → core; easy to double-trigger.
- **Verify**: play/pause/next/prev, seek, background behavior, lock-screen controls, and "source unavailable" fallback.

## 2. Custom source / user API (QuickJS)
- `src/core/init/userApi/` + `src/utils/nativeModules/userApi.ts` + Android `userApi/QuickJS.java` run **user-provided JS** in a native QuickJS engine. This is the only way online playback gets a URL in this build (built-in `apiList` is empty — see API.md).
- JS↔script bridge is async with a 20s timeout (`request`/`response` + `BackgroundTimer`). Bugs here can hang or silently drop requests.
- Android-only: there is **no iOS equivalent** of the QuickJS native module, so user-api (and thus online playback) is effectively Android-only.
- Scripts are untrusted input; validate/contain failures so a bad script can't crash the app.

## 3. Sync
- `src/plugins/sync/` talks to a **user-hosted server** over HTTP + WebSocket (`message2call`). Protocol is in `modules/base/message2call.ts`; versioned constants in `constants.ts`. There is no in-repo server, so protocol changes need coordination.
- Auth uses AES + RSA (credentials encrypted, server public key RSA-wrapped) — `auth.ts`. Mismatched key handling breaks auth silently.
- Sync mutates local lists via `global.list_event`/`dislike_event`; a race between a local edit and a server push can drop or duplicate items.
- Only `list` + `dislike` are synced; do not assume history is synced.

## 4. State / event system (cutting across the app)
- The whole UI reactivity depends on `global.state_event` (async via `setImmediate`). Forgetting to emit after a state mutation = stale UI; emitting without a subscription = silent no-op.
- Singletons are shared by reference; mutating them outside an action (bypassing the emit) is a common source of desync.
- `config/globalData.ts` creates `global.lx` + event hubs **at import time**. Code that runs before it (or in a worker) won't have these globals.

## 5. Persistence / storage
- `src/utils/data.ts` holds large in-memory caches and throttled writes; `plugins/storage.ts` chunks values >500KB. Large lists + aggressive writes can be slow or hit AsyncStorage limits.
- Settings have a **migration path** (`src/config/migrateSetting.ts`, `migrate.ts`). Adding/renaming a `LX.AppSetting` key without a migration breaks existing users' saved settings.
- Many keys are versioned (`@list__<id>`, `@lyric__<id>`, `@music_url__<id>`). Be careful invalidating caches (see `core/music` lyric/URL cache + `core/common` `unlink(TEMP_FILE_PATH)`).
- Filesystem/SAF access (Android scoped storage) is via `src/utils/fs.ts`; permission flow (`core/common.requestStoragePermission`) is Android-specific.

## 6. Music source adapters
- `src/utils/musicSdk/<kw,kg,tx,wy,mg>` target **external, vendor-controlled endpoints**. They break when vendors change APIs, headers, or add anti-bot/crypto (e.g. `kw/decodeLyric.js`). No tests cover these; verify against live endpoints.
- `apis(source)` throws `'Api is not found'` when no api-source is active — callers must handle that (it's expected when no user-api is set).
- `bd` is disabled and `xm` is a stub; don't assume they work.

## 7. Native / platform
- Custom Android Java modules under `android/app/src/main/java/cn/toside/music/mobile/` (`crypto`, `userApi`, `cache`, `lyric`, `utils`). Any JS-side `NativeModules` call must be guarded for missing modules.
- targetSdk 29 (compileSdk 36, minSdk 21) — Android 5+; newer-OS behaviors (background limits, scoped storage) apply. `[待确认: current targetSdk policy]`
- iOS is present but unsupported; Android-only features will not work there.

## 8. Build / dependency risk
- Uses a **fork** of `react-native-track-player` (`@chocabozu/react-native-track-player`) — upstream API differences can bite on upgrades.
- Pinned-ish RN 0.73.11; upgrades are high-touch (native + Babel/Metro + `@react-native/*` presets).
- CI gate is only `lint` + Metro bundle — it does **not** run the app; runtime regressions are not caught automatically.

## How to de-risk changes
1. Re-read the relevant `DATA_FLOW.md` section first.
2. Keep changes within one layer where possible; respect core↔plugin function-level imports.
3. For state: mutate in an action + emit; add a hook to observe.
4. For settings keys: add a migration in `config/migrateSetting.ts`.
5. Run `npm run lint` + `npm run build-test`, then verify on-device (playback, background, source fallback, sync).

## Cross-references
- Mechanisms: `ARCHITECTURE.md`, `DATA_FLOW.md`
- Where things live: `MODULES.md`
- External endpoints: `API.md`
