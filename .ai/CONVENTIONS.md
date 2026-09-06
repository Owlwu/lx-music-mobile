# CONVENTIONS

Observed, project-wide conventions. Follow these to stay consistent with the codebase.

## Language & file layout
- **TypeScript** for new code (`src/core`, `src/store`, `src/screens`, `src/components`, `src/types`). Legacy **JavaScript** remains in `src/utils/musicSdk/*`, `src/theme/*`, and a few `utils/*` (e.g. `request.js`, `message.ts` is TS).
- Platform branching: the codebase uses the `isAndroid` flag / `Platform.OS` from `src/utils/tools.ts` and guards Android-only `NativeModules`. A platform-file convention (`foo.android.ts` / `foo.ios.ts`) is supported by `babel.config.js` `extensions` order but is **not currently used** in `src`; match the existing `isAndroid`/guard style rather than introducing new platform-suffixed files.
- Path alias: `@/*` → `./src/*` (via `babel.config.js` module-resolver + `tsconfig.json` `paths`). Import with `@/...`, e.g. `import settingState from '@/store/setting/state'`.
- One main export per module; state modules export the singleton default plus named sub-state (e.g. `export default playerState` + `export const playInfo = {...}`).

## State / events (the dominant pattern)
- Shared state = **module singletons** in `src/store/<domain>/state.ts`. Do not create ad-hoc globals.
- Mutate via **actions** (`action.ts`), then emit the matching event on `global.state_event` (define it in `src/event/stateEvent.ts` if new).
- Read in React via **hooks** (`hook.ts`) that subscribe to the event; or read the singleton directly in non-React code.
- Non-state app/list/dislike events use `global.app_event` / `global.list_event` / `global.dislike_event`.
- The emitter is async (`setImmediate`), so expect listeners to run on a later tick.

## Component / naming
- React components: `PascalCase` (`function` or `const` component). Files for screens/components generally `PascalCase` or match component name (`PlayerBar/index.tsx`).
- Hooks: `useXxx` (e.g. `useSettingValue`, `useProgress`).
- Core/store functions: `camelCase`, verbs for actions (`updateSetting`, `addListMusics`).
- Constants: `UPPER_SNAKE_CASE` (`LIST_IDS`, `COMPONENT_IDS`, `HEADER_HEIGHT`).
- i18n keys: `module__key` with double underscore (e.g. `player__getting_url`, `search__searching`), referenced via `t(...)`.
- Types: ambient `LX.*` namespace declared in `src/types/*.d.ts` (e.g. `LX.AppSetting`, `LX.Music`, `LX.Source`, `LX.Quality`). Add shared shapes there, not inline.
- `types.ts` in a folder holds local types; `types.d.ts` are ambient declarations.

## ESLint / formatting (see `.eslintrc.cjs`)
- Base: `standard` + `standard-with-typescript` + `react` + `react-hooks`.
- Notably relaxed: `camelcase` off, `eqeqeq` off (`==` allowed), `no-var` **on**, `prefer-const` off, `no-fallthrough` off.
- `space-before-function-paren: never` → `function foo() {}`, `async() => {}` (no space before parens).
- `comma-dangle: always-multiline` (trailing commas in multi-line constructs).
- `@typescript-eslint/no-var-requires` off, `prefer-for-of` on, `no-param-reassign` off.
- JSX uses the **automatic runtime** (`react/jsx-runtime`) — `import React` is not required; most files import only the hooks they use.
- Async: `@typescript-eslint/no-misused-promises` and `no-floating-promises` on — `void` intentionally-floating promises (the codebase uses `void promise` a lot).
- Run `npm run lint:fix` after edits.

## Error handling & logging
- Wrap network/async failures and map to `src/utils/message.ts` `requestMsg` codes; user-facing text via `t(requestMsg.<code>)`.
- Use `src/utils/log` (`log.error/info`) for diagnostics; `src/utils/bootLog` for startup logs. `src/utils/errorHandle.ts` handles global errors.
- Cancellation: prefer the `httpFetch` `cancelHttp()` pattern over ad-hoc aborts; many modules keep a `_*_RequestObj` / `_*_PromiseCancelFn` to cancel superseded requests.

## Persistence
- Always persist through `src/utils/data.ts` (in-memory cache + throttled writes) → `plugins/storage.ts` (AsyncStorage, auto-chunks >500KB).
- All AsyncStorage keys come from `config/constant.ts` (`storageDataPrefix`). Do not hardcode key strings.
- Files (music, downloaded lyrics, caches) via `src/utils/fs.ts`.

## Music source adapters
- New/edited sources live under `src/utils/musicSdk/<id>/` and must expose the standard interface (see `MODULES.md`). `getMusicUrl` should delegate to `apis('<id>')` so it honors the active API source / user api.
- HTTP through `src/utils/request.js`.

## Threading
- No JS worker threads. Long/IO work happens in native modules or async JS; timers via `react-native-background-timer` when the app is backgrounded.

## Cross-references
- Structure & where things go: `ARCHITECTURE.md`, `MODULES.md`
- Build/lint/test: `DEVELOPMENT.md`
