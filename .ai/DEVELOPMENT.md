# DEVELOPMENT

## 前置条件
- Node.js `>= 18`（CI 用 Node 20），npm `>= 8.5.2`
- Android SDK + JDK（Gradle 8.8，`android/local.properties` 指向 SDK）
- 已连接的 Android 设备或模拟器（`run-android` 需要）
- 不需要 iOS 工具链

## 安装
```bash
npm install            # 或 npm ci
```
Metro 按扩展名顺序解析平台文件（`babel.config.js` / `metro.config.js`）；`@` 别名指向 `./src`。

## 开发
| 命令 | 作用 |
| --- | --- |
| `npm start` | 启动 Metro |
| `npm run dev` | `react-native run-android --active-arch-only`（构建+安装） |
| `npm run sc` | `react-native start --reset-cache` |
| `npm run menu` | `adb shell input keyevent 82`（打开开发者菜单） |
| `npm run rd` | React DevTools |

典型循环：一个终端 `npm start`，另一个 `npm run dev`（改 JS 后热更新，改原生需重新 `run-android`）。

## 构建
| 命令 | 作用 |
| --- | --- |
| `npm run pack:android` | `cd android && gradlew.bat assembleRelease`（release APK） |
| `npm run pack:android:debug` | `gradlew.bat assembleDebug`（**改原生后用它验证**） |
| `npm run pack` | 等同 `pack:android` |
| `npm run clear` | `cd android && gradlew.bat clean` |
| `npm run clear:full` | 深度清理（保留 keystore 配置） |
| `npm run bundle-android` | 把 JS 打进 `android/app/src/main/assets/index.android.bundle` |
| `npm run build-test` | 在仓库根输出 `index.android.bundle`（CI 校验用） |
| `npm run build:theme` | `node src/theme/themes/createThemes.js`（重新生成主题） |

> release 签名依赖 `android/keystore.properties`（git-ignored）与 keystore 文件。
> Android SDK 版本：`minSdk 21` / `targetSdk 29` / `compileSdk 36`；applicationId `cn.toside.music.mobile`。

## 校验
| 命令 | 作用 |
| --- | --- |
| `npm run lint` / `lint:fix` | ESLint（`.js,.jsx,.ts,.tsx`） |
| `npm run tsc`（= `typecheck`） | `tsc --noEmit` |
| `npm run build-test` | Metro 打包（能发现悬空 import / 语法错误） |
| `cd android && gradlew.bat assembleDebug` | 原生改动后的编译验证 |

ESLint 配置：`.eslintrc.cjs`（standard + standard-with-typescript + react + react-hooks）。
忽略项包含 `src/utils/simplify-chinese-main/`、主题生成脚本、`publish/` 与 bundle 产物。

## CI（GitHub Actions）
| 工作流 | 作用 |
| --- | --- |
| `.github/workflows/build-test.yml` | PR 门禁：`npm ci` → `npm run lint` → `npm run build-test` |
| `release.yml` / `beta-pack.yml` | release / beta 打包 |
| `publish-version-info.yml` | 发布版本信息（上游用；本 fork 已无应用内更新检查） |

## 原生（android/）
- 原生模块：`crypto`、`cache`、`lyric`（悬浮歌词）、`utils`、`diagnostics`，
  路径 `android/app/src/main/java/cn/toside/music/mobile/`，在 `MainApplication.java` 的 `getPackages()` 注册。
- **`userApi/`（QuickJS 自定义音源）与 `wang.harlon.quickjs:wrapper-android` 依赖已删除**；
  新增原生模块时记得同步 `build.gradle` 依赖与 Package 注册。
- `process.env` 注入在 `metro.config.js`（`LX_VERSION`、`LX_VERSION_CODE`、`LX_DEBUG_MODE`）。

## 约定
- `core` 保持无 React；UI 放 `screens`/`components`
- 持久化只经 `utils/data.ts`（键在 `config/constant.ts`）
- 改完跑 `npm run tsc` + `npm run lint:fix` + `npm run build-test`；动原生再加 `assembleDebug`

## 交叉引用
- 代码风格：`CONVENTIONS.md`
- 模块与数据流：`MODULES.md`、`ARCHITECTURE.md`
