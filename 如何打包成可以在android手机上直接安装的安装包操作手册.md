# LX Music 移动版 Android 安装包打包操作手册（自动化执行版）

> 本手册面向「本地大语言模型 / 自动化脚本」执行。所有命令均为非交互式，可直接复制执行。
> 执行者请严格按顺序完成第 0 至第 6 章，最后按第 8 章自检。

---

## 0. 执行者须知（务必先读）

### 0.1 任务目标

将本仓库源码构建为**已签名的 Android release APK**，该 APK 可直接在 Android 手机上安装。

### 0.2 验收标准

满足以下全部条件即视为任务成功：

1. 命令 `cd android && ./gradlew assembleRelease` 退出码为 `0`；
2. 目录 `android/app/build/outputs/apk/release/` 下存在至少一个 `*.apk`；
3. 存在通用包 `lx-music-mobile-v<版本号>-universal.apk`，或与目标手机架构匹配的 APK；
4. 安装到手机后应用可正常启动（第 7 章）。

### 0.3 执行原则

- **不要使用交互式命令**（如不带参数的 `keytool`、需要输入密码的提示），否则会卡住。
- **每个步骤先检测、再执行、后验证**，不要跳过检查。
- 命令在 **项目根目录** 执行；涉及 Gradle 的命令先 `cd android`。
- 遇到错误优先查第 6 章「错误对照表」，不要盲目重试。
- 所有密码、路径尽量通过环境变量传入，避免写死在仓库文件中。
- `android/keystore.properties`、`android/local.properties`、`android/app/*.keystore` 已被 `.gitignore` 忽略，**不要提交到 git**。

### 0.4 环境假设

- 操作系统：macOS（本手册命令以 macOS 为准，Windows 见各步骤的 Windows 备选命令）。
- 当前工作目录即项目根目录。先确认：

```bash
pwd
ls package.json android/gradlew
```

预期：`package.json` 与 `android/gradlew` 均存在。若不存在，说明不在项目根目录，需先 `cd` 到仓库根目录。

---

## 1. 关键信息速查（构建配置来源）

| 项目 | 值 | 来源 |
| --- | --- | --- |
| 应用包名 | `cn.toside.music.mobile` | `android/app/build.gradle` |
| 版本名 / 版本号 | `1.9.0` / `77` | `package.json` 的 `version` / `versionCode` |
| Gradle 版本 | 8.8 | `android/gradle/wrapper/gradle-wrapper.properties` |
| compileSdk | 36 | `android/build.gradle` |
| buildTools | 35.0.0 | `android/build.gradle` |
| minSdk | 21 | `android/build.gradle` |
| targetSdk | 29 | `android/build.gradle` |
| NDK | 26.1.10909125 | `android/build.gradle` |
| JDK | 17 | `.github/actions/setup/action.yml` |
| Node | 18.x | `.nvmrc` |
| 签名配置 | `android/keystore.properties` | `android/app/build.gradle` |
| 产物目录 | `android/app/build/outputs/apk/release/` | Gradle 默认 |

产物文件名规则：`lx-music-mobile-v<version>-<abi|universal>.apk`。
由于开启了 `enableSeparateBuildPerCPUArchitecture=true` 且 `universalApk=true`，一次 `assembleRelease` 会同时产出 4 个架构包 + 1 个通用包。

---

## 2. 环境要求与自检

### 2.1 版本要求

| 软件 | 要求 | 用途 |
| --- | --- | --- |
| JDK | 17 | Gradle / Android 构建 |
| Node.js | 18.x | 安装依赖、打包 JS |
| npm | >= 8.5.2 | 包管理 |
| Android SDK Platform | android-36 | 编译 |
| Android SDK Build-Tools | 35.0.0 | 编译 |
| Android NDK | 26.1.10909125 | 原生模块 |
| Android Platform-Tools | 任意 | `adb` 安装（可选） |

### 2.2 自检命令

依次执行，确认输出：

```bash
# JDK 17
java -version          # 期望输出包含 version "17.

# Node 18
node -v                # 期望 v18.x.x

# Android SDK
echo "$ANDROID_HOME"   # 期望非空，例如 /Users/<user>/Library/Android/sdk
```

若 `java -version` 报 `Unable to locate a Java Runtime`，执行 2.3 安装 JDK 17。

### 2.3 安装缺失组件（macOS）

```bash
# 安装 JDK 17
brew install --cask temurin@17

# 或安装 Node 18（若当前 Node 不是 18）
brew install node@18
```

安装 JDK 后设置 `JAVA_HOME`（写入当前会话即可，也可写入 `~/.zshrc`）：

```bash
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
export PATH="$JAVA_HOME/bin:$PATH"
```

设置 Android 环境变量：

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$PATH:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin"
```

> Android SDK 通常由 Android Studio 安装，默认路径为 `~/Library/Android/sdk`。若不存在，可安装 Android Studio 或仅安装 command line tools。

### 2.4 安装 SDK / NDK 组件（缺失时）

```bash
sdkmanager "platforms;android-36" "build-tools;35.0.0" "ndk;26.1.10909125"
sdkmanager --licenses
```

`--licenses` 需要输入 `y` 确认，请在交互式终端执行。

### 2.5 生成 `android/local.properties`

Gradle 需要知道 SDK 路径。项目根目录执行：

```bash
printf 'sdk.dir=%s\n' "$ANDROID_HOME" > android/local.properties
cat android/local.properties
```

预期输出形如：`sdk.dir=/Users/<user>/Library/Android/sdk`。

---

## 3. 安装项目依赖

在项目根目录执行：

```bash
npm ci
```

- 预期：安装完成，退出码 `0`，生成 `node_modules/`。
- 若 `node_modules` 已存在且完整，可跳过本步。
- 若 `npm ci` 因锁文件问题失败，可改用 `npm install`。

> 本项目 `package.json` 的 `engines` 要求 Node >= 18。当前机器若为 Node 26，构建原生依赖可能失败，建议切换到 18：`nvm use 18`。

---

## 4. 配置签名证书（Release 必需）

未配置签名时 `assembleRelease` 会因找不到 `android/keystore.properties` 而失败。

### 4.1 生成 keystore（仅首次，非交互式）

在项目根目录执行。**注意：以下命令不弹交互提示，密码通过参数传入。**

```bash
KEYSTORE_PASSWORD='lxmusic123456'   # 本地安装可用默认值；正式发布请改为强密码
KEYSTORE_ALIAS='lxmusic'

keytool -genkeypair -v \
  -keystore android/app/release.keystore \
  -alias "$KEYSTORE_ALIAS" \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass "$KEYSTORE_PASSWORD" \
  -keypass "$KEYSTORE_PASSWORD" \
  -dname "CN=LX Music, OU=Dev, O=LX Music, L=Unknown, ST=Unknown, C=CN"
```

预期：输出 `Generating ... key pair` 等信息，并在 `android/app/` 生成 `release.keystore`。

> 若使用 PKCS12 格式（JDK 9+ 默认），`-keypass` 必须与 `-storepass` 相同。
> 妥善保存该文件和密码：后续覆盖升级必须使用同一签名，否则无法覆盖安装。

### 4.2 写入 `android/keystore.properties`

```bash
cat > android/keystore.properties <<'EOF'
storeFile=release.keystore
storePassword=lxmusic123456
keyAlias=lxmusic
keyPassword=lxmusic123456
EOF
cat android/keystore.properties
```

说明：

- `storeFile` 路径相对于 `android/app/` 解析（`build.gradle` 中 `file(...)` 的基准目录是 app 模块），因此 `release.keystore` 放在 `android/app/` 下并填写文件名即可。
- 若不想创建该文件，也可在构建时用 `-PMYAPP_UPLOAD_*` 参数传入（见第 5.3 节）。

### 4.3 验证签名配置就绪

```bash
ls -l android/app/release.keystore android/keystore.properties
```

两个文件都必须存在。

---

## 5. 执行打包

> 所有 Gradle 命令必须在 `android/` 目录下执行。

### 5.1 全架构打包（默认，生成 5 个 APK）

```bash
cd android
./gradlew assembleRelease
```

预期结尾出现 `BUILD SUCCESSFUL`。首次执行会下载 Gradle 8.8 与依赖，耗时较长，请耐心等待（可能 10 分钟以上）。

### 5.2 只打包主流手机架构（更快，推荐）

现代手机绝大多数为 `arm64-v8a`：

```bash
cd android
./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
```

### 5.3 用参数传入签名（不创建 keystore.properties 时）

```bash
cd android
./gradlew assembleRelease \
  -PMYAPP_UPLOAD_STORE_FILE='release.keystore' \
  -PMYAPP_UPLOAD_KEY_ALIAS='lxmusic' \
  -PMYAPP_UPLOAD_STORE_PASSWORD='lxmusic123456' \
  -PMYAPP_UPLOAD_KEY_PASSWORD='lxmusic123456'
```

### 5.4 Windows 备选命令

```bat
cd android
gradlew.bat assembleRelease
```

> `package.json` 中的 `npm run pack:android` 写死了 `gradlew.bat`，在 macOS/Linux 上不可用；请忽略该脚本，直接使用 `./gradlew`。

### 5.5 调试包（可选，快速验证）

debug 包使用内置 debug 签名，无需第 4 章配置：

```bash
cd android
./gradlew assembleDebug
```

产物在 `android/app/build/outputs/apk/debug/`，不建议作为正式分发包。

---

## 6. 错误对照表

| 现象 / 错误关键字 | 原因 | 处理 |
| --- | --- | --- |
| `Unable to locate a Java Runtime` / `JAVA_HOME is not set` | 未安装或未配置 JDK 17 | 见 2.3，安装 temurin@17 并导出 `JAVA_HOME` |
| `Failed to apply plugin ... Java 17` / `Unsupported class file major version` | JDK 版本不对（非 17） | 切换到 JDK 17：`export JAVA_HOME=$(/usr/libexec/java_home -v 17)` |
| `SDK location not found` | 缺少 `android/local.properties` 或 `ANDROID_HOME` | 见 2.5 |
| `NDK not configured` / `No version of NDK matched` | NDK 版本缺失 | `sdkmanager "ndk;26.1.10909125"` |
| `Failed to find Build Tools revision 35.0.0` | Build-Tools 缺失 | `sdkmanager "build-tools;35.0.0"` |
| `Failed to find target with hash string 'android-36'` | Platform 缺失 | `sdkmanager "platforms;android-36"` |
| `keystore.properties (No such file or directory)` | 未配置签名 | 见第 4 章 |
| `Keystore was tampered with, or password was incorrect` | 密码不匹配 | 重新确认 `keystore.properties` 中的密码，或删除证书重新生成 |
| `gradlew: command not found` / 权限不足 | 用错命令或文件无执行权限 | macOS/Linux 用 `./gradlew`；必要时 `chmod +x android/gradlew` |
| `Could not resolve ...` / 依赖下载超时 | 网络问题 | 项目已配阿里云镜像；重试或配置代理；可先 `./gradlew clean` |
| `Execution failed for task ':app:...hermes...'` | Node 版本不兼容 | 切换到 Node 18 后重试 |
| `Duplicate resources` / 缓存异常 | 增量构建缓存损坏 | `cd android && ./gradlew clean` 后重新构建 |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | 手机上已装不同签名的同包名应用 | 先卸载旧应用：`adb uninstall cn.toside.music.mobile` |
| 构建成功但目录无 APK | 输出被清理或任务选错 | 确认执行的是 `assembleRelease`，检查 `android/app/build/outputs/apk/release/` |

---

## 7. 校验产物与安装

### 7.1 校验产物

```bash
ls -lh android/app/build/outputs/apk/release/
```

预期包含（版本号以实际为准）：

```
lx-music-mobile-v1.9.0-arm64-v8a.apk
lx-music-mobile-v1.9.0-armeabi-v7a.apk
lx-music-mobile-v1.9.0-x86_64.apk
lx-music-mobile-v1.9.0-x86.apk
lx-music-mobile-v1.9.0-universal.apk
```

架构选择：

- 不确定手机架构 → `universal.apk`（兼容全部，体积最大）；
- 近几年手机 → `arm64-v8a.apk`（体积小）。

### 7.2 安装到手机（adb，可选）

```bash
adb devices          # 确认设备已连接且授权
adb install -r android/app/build/outputs/apk/release/lx-music-mobile-v1.9.0-universal.apk
```

`-r` 为覆盖安装（保留数据）。看到 `Success` 即安装完成。

### 7.3 手动安装（无 adb）

把 APK 传到手机（数据线 / 网盘 / 聊天工具），在手机文件管理器中点击安装；若提示「未知来源」，在系统设置中允许后重试。

---

## 8. 一键脚本（推荐执行方式）

仓库提供脚本 `scripts/pack-android.sh`，自动完成第 3 至第 6 章全部步骤（环境检测、依赖安装、签名生成、构建、产物校验）。

### 8.1 基本用法

```bash
bash scripts/pack-android.sh
```

### 8.2 常用参数

```bash
# 只打包 arm64-v8a
ARCH=arm64-v8a bash scripts/pack-android.sh

# 指定签名密码
KEYSTORE_PASSWORD='你的强密码' bash scripts/pack-android.sh
```

脚本可识别的环境变量：`ARCH`、`KEYSTORE_PASSWORD`、`KEYSTORE_ALIAS`、`ANDROID_HOME`、`JAVA_HOME`。

### 8.3 脚本行为说明

1. 定位项目根目录；
2. 自动探测并校验 JDK 17、Node、Android SDK；
3. 写入 `android/local.properties`；
4. `node_modules` 缺失时执行 `npm ci`；
5. `android/keystore.properties` 缺失时生成证书与配置（默认密码 `lxmusic123456`，仅本地安装用）；
6. 执行 `./gradlew assembleRelease`；
7. 列出生成的 APK。

> 脚本已存在时可重复执行（幂等）；已有签名配置和依赖会被复用。

---

## 9. 执行清单（Checklist）

执行者请逐项勾选确认：

- [ ] 已确认工作目录为项目根目录（`package.json`、`android/gradlew` 存在）
- [ ] `java -version` 为 17
- [ ] `node -v` 为 18.x
- [ ] `ANDROID_HOME` 已设置且目录存在
- [ ] 已安装 `platforms;android-36`、`build-tools;35.0.0`、`ndk;26.1.10909125`
- [ ] `android/local.properties` 已生成且 `sdk.dir` 正确
- [ ] 已执行 `npm ci`，`node_modules` 存在
- [ ] `android/app/release.keystore` 与 `android/keystore.properties` 均存在
- [ ] `cd android && ./gradlew assembleRelease` 输出 `BUILD SUCCESSFUL`
- [ ] `android/app/build/outputs/apk/release/` 下存在 `*.apk`
- [ ] （可选）`adb install -r <apk>` 返回 `Success`

---

## 10. 完整命令速查（可直接整段执行）

> 以下为手动流程的一站式汇总，等效于脚本。假设 macOS、已安装基础环境。

```bash
# 0) 进入项目根目录
cd /path/to/lx-music-mobile

# 1) 环境变量
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
export PATH="$JAVA_HOME/bin:$PATH"
export ANDROID_HOME="$HOME/Library/Android/sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$PATH:$ANDROID_HOME/platform-tools"

# 2) 依赖
npm ci

# 3) 生成 local.properties
printf 'sdk.dir=%s\n' "$ANDROID_HOME" > android/local.properties

# 4) 签名（仅首次）
keytool -genkeypair -v \
  -keystore android/app/release.keystore \
  -alias lxmusic -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass lxmusic123456 -keypass lxmusic123456 \
  -dname "CN=LX Music, OU=Dev, O=LX Music, L=Unknown, ST=Unknown, C=CN"
cat > android/keystore.properties <<'EOF'
storeFile=release.keystore
storePassword=lxmusic123456
keyAlias=lxmusic
keyPassword=lxmusic123456
EOF

# 5) 打包
cd android && ./gradlew assembleRelease

# 6) 校验
ls -lh app/build/outputs/apk/release/*.apk
```
