# CONVENTIONS

项目通用约定。照着写才能和现有代码一致。

## 语言与文件布局
- 新代码用 **TypeScript**（`core`、`store`、`screens`、`components`、`types`）。历史 **JavaScript** 保留在
  `src/theme/*`、部分 `utils/*`（如 `request.js`）与少量 hooks。
- 平台差异：现有代码用 `isAndroid` / `Platform.OS`（`utils/tools.ts`）并守卫 Android 专属 `NativeModules`。
  `babel.config.js` 支持 `foo.android.ts` 扩展名优先，但 `src` 目前**没有**使用，别为此重构。
- 路径别名：`@/*` → `./src/*`（`babel.config.js` module-resolver + `tsconfig.json` paths）。
- 模块默认导出一个主对象；状态模块默认导出单例，另导出命名子状态。

## 状态 / 事件（主导模式）
- 共享状态 = `src/store/<domain>/state.ts` 的**模块单例**；不要新造全局变量。
- 通过 **action**（`action.ts`）修改，然后 emit 对应的 `global.state_event` 事件（新事件加到 `src/event/stateEvent.ts`）。
- React 里通过 **hook**（`hook.ts`）订阅事件读取；非 React 代码可直接读单例。
- 应用/列表/不喜欢事件分别走 `global.app_event` / `global.list_event` / `global.dislike_event`。
- 发射器是异步的（`setImmediate`），监听器在后续 tick 执行。

## 组件 / 命名
- React 组件 PascalCase；屏幕/组件文件一般 PascalCase 或与组件同名（`PlayerBar/index.tsx`）。
- Hooks：`useXxx`（`useSettingValue`、`usePlayTime`）。
- core/store 函数 camelCase，动作用动词（`updateSetting`、`addListMusics`）。
- 常量 UPPER_SNAKE_CASE（`LIST_IDS`、`COMPONENT_IDS`、`HEADER_HEIGHT`）。
- i18n 键用双下划线 `module__key`（`player__getting_url`），通过 `t(...)` 引用。
- 类型：ambient `LX.*`（`src/types/*.d.ts`）；`types.ts` 放局部类型，`types.d.ts` 是 ambient。

## ESLint / 格式（见 `.eslintrc.cjs`）
- 基座：`standard` + `standard-with-typescript` + `react` + `react-hooks`
- 放宽：`camelcase` off、`eqeqeq` off（允许 `==`）、`no-var` on、`prefer-const` off、`no-fallthrough` off
- `space-before-function-paren: never` → `function foo() {}`、`async() => {}`
- `comma-dangle: always-multiline`
- `@typescript-eslint/no-var-requires` off、`prefer-for-of` on、`no-param-reassign` off
- JSX 用自动 runtime（`react/jsx-runtime`），无需 `import React`
- 异步：`no-floating-promises` / `no-misused-promises` 开启 → 有意不 await 的 Promise 用 `void`
- 改完跑 `npm run lint:fix`

## 错误处理与日志
- 网络/异步失败映射到 `utils/message.ts` 的 `requestMsg` 码，用户可见文案用 `t(requestMsg.<code>)`
- 诊断日志用 `utils/log`（`log.error/info`，统一落到 `runtime.log`）；启动日志 `utils/bootLog`；全局异常 `utils/errorHandle.ts`
- **导入本地歌曲**的失败记录用 `utils/importLog`（单独落 `import.log`，只在设置页「查看日志」展示）；
  其它模块不要写这一份，否则用户看导入失败原因时会被无关错误淹没
- 取消请求优先用 `httpFetch` 的 `cancelHttp()` 模式（模块内保留 `_*_RequestObj`）

## 持久化
- 一律经 `utils/data.ts`（内存缓存 + 节流写）→ `plugins/storage.ts`（AsyncStorage，>500KB 自动分块）
- 所有键来自 `config/constant.ts` 的 `storageDataPrefix`，不硬编码字符串
- 文件（音乐、歌词、缓存）走 `utils/fs.ts`

## 播放器边界
- `core/player` 负责状态与业务，`plugins/player` 负责 TrackPlayer 引擎与服务；两者存在**设计上的循环引用**，
  只在函数调用层面互相引用，避免模块求值副作用（见 `RISKS.md` §1）
- 播放器动作统一从 `core/player/player.ts` 暴露，UI 不直接调 TrackPlayer

## 线程
- 没有 JS Worker。耗时/IO 交给原生模块或异步 JS；后台计时用 `react-native-background-timer`。

## 与已验证的取舍
- 本地歌曲 `id` 是文件路径（Android 可能是 `content://` 或授权目录路径），不做哈希重映射
- 同步失败不弹 toast，状态经 `store/sync` 展示（设置页可见）
