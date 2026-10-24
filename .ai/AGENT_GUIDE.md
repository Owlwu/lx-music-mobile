# AGENT_GUIDE — 在这个仓库里怎么干活

> 实战手册。先看这里，再按需跳转。

## 阅读顺序
1. `PROJECT.md` — 是什么、技术栈、入口、边界（纯本地播放器）
2. `ARCHITECTURE.md` — 分层、单例状态 + 事件、依赖方向（最容易搞错的一点）
3. `MODULES.md` — 每个功能在哪
4. `DATA_FLOW.md` — 导入/播放/歌词/同步的端到端流程
5. `API.md` — 同步 RPC、HTTP 层、原生桥、持久化键
6. `CONVENTIONS.md` + `RISKS.md` — 动手前必读
7. `DEVELOPMENT.md` — 构建/运行/验证

## 速查表
| 关注点 | 位置 |
| --- | --- |
| 引导入口 | `index.js` → `src/app.ts`；`config/globalData.ts` |
| 顺序初始化 | `core/init/index.ts` |
| 状态单例 | `store/<domain>/{state,action,hook}.ts` |
| 事件 | `event/{Event,stateEvent,appEvent,listEvent,dislikeEvent}.ts` |
| 播放控制 | `core/player/player.ts` + `plugins/player/` |
| 本地资源解析 | `core/music/{index,local,utils}.ts`、`utils/localMediaMetadata.ts` |
| 列表 | `core/list.ts` + `utils/listManage.ts` + `store/list/` |
| 持久化 | `utils/data.ts`（键在 `config/constant.ts`） |
| 同步 | `core/sync.ts` + `plugins/sync/`（含 `client/modules/musicFile`） |
| 文件系统 | `utils/fs.ts`（SAF/授权） |
| 屏幕注册 | `navigation/registerScreens.tsx` + `screenNames.ts` |
| 首页布局 | `screens/Home/Vertical/`、`screens/Home/Horizontal/` |
| 设置项 UI | `screens/Home/Views/Setting/settings/<分组>/` |
| 原生模块 | `src/utils/nativeModules/` + `android/app/src/main/java/cn/toside/music/mobile/` |
| 诊断日志 | `utils/log.ts`、`runtimeLog.ts`、`bootLog.ts`、`stallWatchdog.ts`、`playbackHeartbeat.ts` |

## 各层规则
- **UI** → `src/screens/*`、`src/components/*`
- **业务逻辑** → `src/core/*`（无 React）
- **共享状态** → `src/store/<domain>/{state,action,hook}.ts`
- **平台差异** → 现有代码用 `isAndroid` / `Platform.OS` 守卫（`.android.ts` 分文件机制可用但当前未使用）
- **共享类型** → `src/types/*.d.ts` 的 `LX.*` 命名空间

## 常见任务

### 加一个屏幕
1. `screens/` 新建组件目录
2. `navigation/screenNames.ts` 加名字，`registerScreens.tsx` 注册（包 `<Provider>`）
3. `navigation/navigation.ts` 加 `pushXxxScreen`
4. 文案加到 `lang/{zh-cn,zh-tw,en-us}.json`

### 加一个设置项
1. `config/setting.ts`（`LX.AppSetting` 类型）+ `config/defaultSetting.ts`（默认值）
2. `screens/Home/Views/Setting/settings/<分组>/` 加 UI 并登记到该分组列表
3. 读：`useSettingValue('group.key')`；写：`core/common.updateSetting({ 'group.key': v })`
4. 老用户迁移：`config/migrateSetting.ts`

### 加一个状态字段（最容易做错）
1. `store/<domain>/state.ts` 加字段
2. `store/<domain>/action.ts` 加 action：改 state + `global.state_event.xxx(...)`
3. `event/stateEvent.ts` 加事件方法（需通知 UI 时）
4. `store/<domain>/hook.ts` 加 hook
5. 需持久化 → `utils/data.ts` 加读写函数（键放 `storageDataPrefix`）

### 加一个同步动作
- 客户端：`plugins/sync/client/modules/<feature>/` 的 `handler.ts` / `localEvent.ts`，并在 `modules/index.ts` 注册
- 桌面端 `server/` 也要加（镜像实现）；能力变更同步 `plugins/sync/constants.ts` 与桌面端 `constants_sync.ts`

### 改原生（android/）
- 改 Java 后必须 `gradlew.bat assembleDebug` 验证；JS 侧 `NativeModules` 访问要守卫
- 新原生模块要在 `MainApplication.java` 的 `getPackages()` 注册

### 加联网能力（未来：在线歌词/封面匹配）
- 只做独立小模块，用 `utils/request.js`；结果写回现有歌词缓存 / `meta.picUrl`
- 不要复活 musicSdk / userApi / 换源逻辑

## 验证（无测试框架）
- **必须**：`npm run tsc` + `npm run lint`
- **打包校验**：`npm run build-test`（Metro bundle 必须成功，CI 同款）
- **原生改动**：`cd android && gradlew.bat assembleDebug`
- **真机**：`npm run dev`，验证播放/后台/通知栏/锁屏/导入/同步

## 规则清单
- 状态只经 action 改并 emit；不要直接改单例
- `core` 保持无 React；`plugins/player` ↔ `core/player` 是设计上的循环，保持函数级引用
- 持久化只走 `utils/data.ts`，不要直接 AsyncStorage
- 新 AsyncStorage 键必须进 `config/constant.ts`
- 浮空 Promise 用 `void`（ESLint 强制）
- 同步连接失败必须 `.catch`（否则用户会看到未处理的 Promise 拒绝提示）
- 交付前跑 `lint:fix`

## 坑（详见 RISKS.md）
- 本地歌曲 `id` = 文件路径，移动文件后旧记录失效
- 别名 `@` → `./src`（babel/metro）；不要用相对层级绕
- 事件是 `setImmediate` 异步派发，改完状态立刻读旧值会拿到旧数据
