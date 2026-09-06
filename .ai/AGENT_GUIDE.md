# AGENT_GUIDE

Instructions for AI agents working in this repo. Read the referenced docs **on demand**, not all at once, to save context.

## Before starting any task
1. Read this file + `PROJECT.md` (what the app is, stack, layout).
2. Read `ARCHITECTURE.md` to understand the layering and the singleton+event state model — this is the #1 thing to get wrong.
3. Look up only the modules you'll touch in `MODULES.md`.
4. If your task crosses a workflow (search / play / list / sync / startup), read the matching section in `DATA_FLOW.md`.
5. If your task touches network or music sources, read `API.md`.
6. Always skim `RISKS.md` for the areas you're about to change.

## When modifying code — rules
- **Stay in the right layer.**
  - UI/visual changes → `src/screens/*`, `src/components/*`.
  - Business logic → `src/core/*` (keep it UI-free; no React).
  - Shared data → `src/store/<domain>/{state,action,hook}.ts`.
  - Platform behavior → use `*.android.ts` files rather than `Platform.OS` where sensible.
- **State changes go through actions + events.** Mutate a singleton in an `action.ts`, then emit the matching `global.state_event` (add the event to `src/event/stateEvent.ts` if new). Add a `hook.ts` for UI to read it. Never mutate a singleton and skip the emit.
- **New shared types** → declare in `src/types/*.d.ts` under the `LX.*` namespace.
- **New settings keys** → add to the `LX.AppSetting` type, `src/config/defaultSetting.ts`, **and** a migration in `src/config/migrateSetting.ts` (existing users have saved settings).
- **New AsyncStorage keys** → add to `config/constant.ts` (`storageDataPrefix`); always read/write via `utils/data.ts`.
- **New/changed music source** → under `src/utils/musicSdk/<id>/` with the standard interface; `getMusicUrl` must delegate to `apis('<id>')`.
- **Respect the core↔plugin player boundary** — import functions, not module-eval side effects (see RISKS.md §1).
- Follow `CONVENTIONS.md`: `@/` alias, automatic JSX runtime (no `import React` needed), `void` floating promises, `npm run lint:fix`.
- Don't introduce a state library, a new HTTP client, or a direct AsyncStorage call — use the existing patterns.

## After completing a task — verification
- Run `npm run lint` (fix all errors; CI enforces this).
- Run `npm run build-test` (Metro bundle must succeed) — this is the CI gate.
- For player/sync/native/storage changes, verify on an Android device (playback controls, background, source fallback, sync) since CI does not run the app.
- Confirm no new `console.log` noise and no secrets/keys committed.
- If you added/changed a module, event, setting, endpoint, or convention, update the matching `.ai` doc below (see "Keeping .ai current").

## Keeping `.ai` current (required)
After any change that affects structure, behavior, or conventions, update the affected doc so it stays accurate:
| Change | Update |
| --- | --- |
| New/removed module or directory responsibility | `MODULES.md` |
| New layering / state / data-flow change | `ARCHITECTURE.md`, `DATA_FLOW.md` |
| New network source / endpoint / user-api / sync protocol | `API.md` |
| New/changed build, run, test, or CI step | `DEVELOPMENT.md` |
| New convention or style rule | `CONVENTIONS.md` |
| New fragile area or known pitfall | `RISKS.md` |
| Feature/stack/platform change | `PROJECT.md` |

### Source-of-truth rule
- **When a `.ai` doc conflicts with the code, the code wins.** Trust the source, fix the doc, and note the discrepancy.
- Mark anything you cannot confirm from the code as `[待确认: ...]` instead of guessing.
- Do not record secrets, tokens, passwords, or API keys in these docs.
- Keep cross-references (`Cross-references` sections) consistent when you rename/repurpose a doc.

## Quick orientation map
- "Where does X live?" → `MODULES.md`
- "How does X work end-to-end?" → `DATA_FLOW.md`
- "What's fragile here?" → `RISKS.md`
- "How do I build/test?" → `DEVELOPMENT.md`
- "How should I write this?" → `CONVENTIONS.md`
