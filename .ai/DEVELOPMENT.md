# DEVELOPMENT

## Prerequisites
- Node.js (engines `>=18.0.0`, CI uses Node 20), npm (>=8.5.2).
- Android SDK + JDK for building the native app (Android-only target).
- A connected Android device/emulator for `run-android`.
- No iOS toolchain needed (iOS is unsupported/untested).

## Setup
```bash
npm install            # or: npm ci
```
Metro resolves platform files by extension order (see `babel.config.js` / `metro.config.js`); the `@` alias maps to `./src`.

## Run / develop
| Command | What it does |
| --- | --- |
| `npm start` | Start Metro bundler |
| `npm run dev` | `react-native run-android --active-arch-only` (build+install to device) |
| `npm run sc` | `react-native start --reset-cache` (clear Metro cache) |
| `npm run menu` | `adb shell input keyevent 82` (open device app drawer, dev helper) |
| `npm run rd` | Open React DevTools |

Typical dev loop: `npm start` in one terminal, `npm run dev` in another.

## Build
| Command | What it does |
| --- | --- |
| `npm run pack` | = `pack:android` → `cd android && gradlew.bat assembleRelease` (release APK/AAB) |
| `npm run pack:android:debug` | `./gradlew assembleDebug` (note: uses `./gradlew`, the unix wrapper) |
| `npm run clear` | `cd android && gradlew.bat clean` |
| `npm run clear:full` | `git clean -fdx` (keeps `android/keystore.properties`, `*.keystore`) |
| `npm run bundle-android` | Bundle JS into `android/app/src/main/assets/index.android.bundle` |
| `npm run build-test` | Bundle (dev) to repo root `index.android.bundle` — used by CI |
| `npm run build:theme` | `node src/theme/themes/createThemes.js` (regenerate theme files) |
| `npm run publish` | `node publish` (release/publish helper) |

> Windows note: `pack`/`clear` use `gradlew.bat`; `pack:android:debug` uses `./gradlew`. Keep the correct one for your OS.
> Release signing uses keystore files referenced via `android/keystore.properties` (git-ignored). `[待确认: release keystore source in CI]`

## Lint
- `npm run lint` → `eslint . --ext .js,.jsx,.ts,.tsx`
- `npm run lint:fix` → same with `--fix`
- Config: `.eslintrc.cjs` (standard + `standard-with-typescript` + react + react-hooks, with several relaxed rules). Prettier via `prettier config standard`.
- ESLint ignores include `src/utils/simplify-chinese-main/`, the theme image/`createThemes` JS, `test.js`, `publish/`, and the bundle output.

## Tests
- **No automated test framework** (no Jest config; not in CI). The only de-facto gate is CI (`.github/workflows/build-test.yml`) on PRs to `dev`:
  1. `npm ci`
  2. `npm run lint`
  3. `npm run build-test` (Metro bundle must succeed)
- `test.js` at the repo root is a **manual demo** (network/polyfill scratch), not a test — it's ESLint-ignored.
- `src/utils/nativeModules/cryptoTest.ts` is a manual native-crypto exerciser, not a test.
- **Verify changes by** running `npm run lint` and a successful bundle/build, and by exercising the app on a device.

## Environment / platform-specific code
- Platform branching is done mainly via the `isAndroid` flag / `Platform.OS` in `src/utils/tools.ts`, and by guarding Android-only `NativeModules` access. A platform-file convention (`foo.android.ts` before `foo.ts`, resolved by `babel.config.js` extensions) is **available** but is **not currently used** in `src` — prefer the existing `isAndroid`/guard style to match the codebase.
- Native modules are Android-only; guard `NativeModules` access for any cross-platform path.
- `process.env` values are injected at build via `metro.config.js` (`LX_VERSION`, `LX_VERSION_CODE`, `LX_DEBUG_MODE`).

## CI (GitHub Actions)
- `.github/workflows/build-test.yml` — PR to `dev`: lint + bundle (the "test" gate).
- `.github/workflows/release.yml` / `beta-pack.yml` — release & beta packaging.
- `.github/workflows/publish-version-info.yml` — publishes version info (used by in-app update check).
- Reusable actions in `.github/actions/setup`, `.github/actions/upload-artifact`.

## Conventions to follow when building
- Keep `src/core` UI-free; put UI in `screens`/`components`.
- Persist via `utils/data.ts` (don't call AsyncStorage directly); keys live in `config/constant.ts`.
- Run `npm run lint:fix` and `npm run build-test` before considering a change done.

## Cross-references
- Code style details: `CONVENTIONS.md`
- Where new data/events live: `ARCHITECTURE.md`, `MODULES.md`
