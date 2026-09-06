# PROJECT — LX Music Mobile

## Overview
- **Name**: lx-music-mobile (LX Music / 洛雪音乐助手)
- **Purpose**: A music player app that aggregates multiple Chinese music platforms (Kuwo, Kugou, QQ Music, NetEase, Migu) plus local files and user-provided "custom source" scripts.
- **Version**: 1.8.4 (see `package.json` `version` + `versionCode`)
- **Repo**: https://github.com/lyswhut/lx-music-mobile
- **License**: Apache-2.0 (+ a project-specific copyright/data agreement in `README.md` §"项目协议")

## Core features
- Search music / songlists across multiple online sources; hot search; leaderboard (charts); tip search.
- Playback of online (streaming URL), local, and downloaded tracks, with lyric display.
- "My lists" (default / love / temp / user lists), play history ("played list"), "play later" (temp) list, dislike list.
- Multi-source "toggle source" fallback when a track cannot be resolved from its original source.
- Custom API source ("user api") — user-supplied JS scripts executed natively to fetch music URLs / lyrics / pics.
- Optional data sync over a self-hosted sync server (lists + dislike list).
- Themes, i18n (zh-cn / zh-tw / en-us), font-size scaling, desktop-lyric mode, horizontal/vertical layouts.
- Auto-update check (Android).

## Tech stack
| Concern | Tech |
| --- | --- |
| Language | TypeScript (majority) + legacy JavaScript (esp. `src/utils/musicSdk/*`, `src/theme/*`) |
| UI framework | React 18.2 + **React Native 0.73.11** |
| Native navigation | `react-native-navigation` 7.39.2 (native stack, NOT react-navigation) |
| State management | **Custom singleton store** (module singletons + actions + React hooks). NOT Redux (README is outdated; Redux code is commented out in `src/store/Provider/Provider.tsx`). |
| Eventing | Custom `Event` emitter (`src/event/Event.ts`); global hubs `global.state_event`, `global.app_event`, `global.list_event`, `global.dislike_event` |
| Audio playback | `react-native-track-player` (fork, `src/plugins/player/*`) |
| Persistence | `@react-native-async-storage/async-storage` (K/V, chunked) + `react-native-fs` / `react-native-file-system` (files) |
| Sync | HTTP (auth) + WebSocket (`message2call`) RPC to a self-hosted server |
| Native modules | Custom Android Java modules (`crypto`, `userApi`/QuickJS, `cache`, `lyric`, `utils`) |
| Build | Gradle (Android). Metro + Babel + module-resolver (`@` → `./src`) |

## Platforms
- **Android 5+** (minSdk 21, targetSdk 29, compileSdk 36). Primary and only actively supported platform.
- iOS folder exists (`ios/`) but **no plan to support iOS**; many features (user-api native module, scoped storage) are Android-only. Treat iOS as untested/unsupported. `[待确认: iOS buildability]`

## Entry point & startup
- `index.js` (project root) → imports `./shim` then `./src/app`.
- `src/app.ts` is the real bootstrap:
  1. Sets up `global.lx` (`src/config/globalData.ts`), loads font size + window size.
  2. Listens for native "app launched" event (`src/navigation/regLaunchedEvent.ts`).
  3. On launch: `src/core/init/index.ts` runs the ordered init (setting → theme → i18n → userApi → apiSource → player service → player → data → common state → sync), then `navigations.pushHomeScreen()`.

## Main directories (all under `src/`)
- `config/` — settings model & defaults, constants, migration, global runtime object.
- `core/` — **business logic, no React** (player, music, search, list, songlist, sync, userApi, apiSource, theme, version, `init/`).
- `store/` — per-domain singleton state + actions + hooks (`setting`, `player`, `list`, `search`, `theme`, `sync`, `version`, `common`, `dislikeList`, `userApi`, `hotSearch`, `leaderboard`, `songlist`).
- `event/` — emitter base + state/app/list/dislike event hubs.
- `plugins/` — `player` (TrackPlayer wrapper), `sync` (client), `storage` (AsyncStorage wrapper).
- `navigation/` — react-native-navigation setup, screen registry, screen push helpers, deep links.
- `screens/` — the 4 React screens: `Home`, `PlayDetail`, `SonglistDetail`, `Comment`.
- `components/` — reusable UI (`player/PlayerBar`, `common/*`, modals, list rows, etc.).
- `utils/` — helpers; notably `musicSdk/` (per-source API modules), `nativeModules/` (bridges), `data.ts` (persistence), `request.js` (HTTP).
- `lang/` — i18n JSON + runtime.
- `theme/` — theme colors/definitions (mostly JS).
- `types/` — ambient `LX.*` TypeScript declarations (`.d.ts`).

## Commands (see DEVELOPMENT.md for detail)
- Dev (Android): `npm run dev`
- Metro: `npm start` / reset cache: `npm run sc`
- Lint: `npm run lint` / `npm run lint:fix`
- Build release APK: `npm run pack` (→ `cd android && gradlew.bat assembleRelease`)
- Theme build: `npm run build:theme`

## Cross-references
- Architecture & layering: `ARCHITECTURE.md`
- Module map & responsibilities: `MODULES.md`
- Key workflows (search / play / list / sync): `DATA_FLOW.md`
- Network & music sources: `API.md`
- Build/run/test: `DEVELOPMENT.md`
- Code style: `CONVENTIONS.md`
- Fragile areas: `RISKS.md`
- Agent workflow: `AGENT_GUIDE.md`
