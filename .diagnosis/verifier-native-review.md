# verifier 独立复核：Lead 原生侧发现（对抗性验证）

复核对象：`.diagnosis/lead-native-findings.md`（F1-F4）
复核方法：只读源码 + 读 Gradle **打包产物**中的合并清单（不运行命令）
复核结论：**F1 不成立（推翻）**，F2 部分成立，F3/F4 与我独立读到的一致。

---

## 🔴 F1 被推翻：前台服务 / WakeLock 权限**实际存在**

Lead 原结论（`lead-native-findings.md:8-20`）：Manifest 缺少 `FOREGROUND_SERVICE`、
`FOREGROUND_SERVICE_MEDIA_PLAYBACK`、`WAKE_LOCK`，且无任何 `<service>` 声明
→ 后台播放被系统冻结/杀死。

### 证据 1：library manifest 自带这些声明
`node_modules/react-native-track-player/android/src/main/AndroidManifest.xml`（全文 26 行）
```xml
L5   <uses-permission android:name="android.permission.WAKE_LOCK" />
L6   <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
L11  <service android:name=".service.MusicService" android:enabled="true" android:exported="true">
L12-14  <intent-filter><action android:name="android.intent.action.MEDIA_BUTTON" /></intent-filter>
L18  <receiver android:name="androidx.media.session.MediaButtonReceiver" android:exported="true">
```

### 证据 2（决定性）：已打包进 release APK 的合并清单
`android/app/build/intermediates/packaged_manifests/release/processReleaseManifestForPackage/arm64-v8a/AndroidManifest.xml`
```
L20  <uses-permission android:name="android.permission.WAKE_LOCK" />
L21  <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
L137-144  <service
            android:name="com.guichaguri.trackplayer.service.MusicService"
            android:enabled="true" android:exported="true" >
            <intent-filter><action android:name="android.intent.action.MEDIA_BUTTON" /></intent-filter>
          </service>
L145-151  <receiver android:name="androidx.media.session.MediaButtonReceiver" android:exported="true" >
```
这是 **packaged_manifests** 阶段产物，即**真正进入 release APK 的最终清单**，
不是 library 的中间产物。

### 误判原因（方法论教训）
1. Lead grep 的范围是 `android/` 目录 → 零命中。但声明位于 **node_modules 内 library 的
   manifest**，由 Gradle **manifest merger** 自动合并进 app。**只读 app 的
   `src/main/AndroidManifest.xml` 无法判断权限是否齐全。**
2. 因此 `lead-native-findings.md:12`「全仓 grep `FOREGROUND_SERVICE|WAKE_LOCK|
   foregroundServiceType` → No matches found（android 目录零命中）」这个**搜索范围本身**
   导致了错误结论：零命中 ≠ 缺失，只是没搜 node_modules。

### 影响
- **F1 的归因（缺少前台服务 → 后台被冻结 → 歌曲不播放 + 空白）必须撤回。**
- 「玩游戏时更易复现」**不能**再用"没有前台服务"解释。后台播放基础设施是齐备的。
- P0 建议「补齐前台服务 + 权限」**是无效修复方向**，不应写入最终交付。

---

## 🟠 F2 部分成立

| Lead 的子结论 | 复核结果 |
|---|---|
| 无 `largeHeap` | ✅ **成立**。打包清单 grep `largeHeap` → 零命中 |
| 无 `onTrimMemory`/`onLowMemory` 覆写 | ✅ 与 `MainApplication.java` 一致（Lead 已给行号） |
| 无内存压力回调 → 无法自救 | ✅ 推论合理 |

---

## 🟡 Lead 漏掉的一条：`targetSdkVersion = 29`

`android/app/build/intermediates/packaged_manifests/release/processReleaseManifestForPackage/arm64-v8a/AndroidManifest.xml:7-9`
```xml
<uses-sdk android:minSdkVersion="21" android:targetSdkVersion="29" />
```

### 事实
1. Lead 说「`foregroundServiceType` 零命中」——**这一条本身是对的**：
   合并清单 L137-144 的 `<service>` 确实**没有** `android:foregroundServiceType`。
2. **但**：`foregroundServiceType` 的强制要求自 **targetSdk 34 (Android 14)** 起生效
   （缺失会抛 `MissingForegroundServiceTypeException`）。
   本工程 targetSdk=29 → **当前不会因此崩溃**。这是"侥幸合规"，不是缺陷触发。
3. targetSdk 29 (Android 10) 在 **Android 12+ 真机**上会进入兼容模式，行为与
   官方 targetSdk 34 构建**不同**：后台启动 Activity 限制、前台服务启动限制
   （`ForegroundServiceStartNotAllowedException`）、`exported` 默认值语义等均按 29 规则处理。
4. 这构成一个**独立于 F1 的、值得纳入排查的风险面**，但**同样需要真机日志确认**，
   不能直接断言因果。

### 结论
不要在最终交付里把 targetSdk 29 写成"已确认根因"。它是**待验证的高价值假设**，
且正好是本次运行时日志要回答的问题。

---

## F3 / F4 复核
- F3（日志无限增长）：与我独立审查一致，且**已确认 T2 的修复目前尚未真正生效**
  （见 `verifier-t2-safety-review.md` 的 CRITICAL-1b：legacy 轮转比较对象错误）。
- F4（启动链路无超时兜底）：与我对 `src/app.ts` 的基线一致（T4 正在处理）。
- 两者均未发现与 Lead 结论冲突之处。

---

## 复核方法论声明（供 Lead 判断可信度）
- 本复核**未运行任何命令**（pwsh 全挂），全部基于 `read`/`grep`/`glob` 读取的**源码与构建产物原文**。
- `packaged_manifests` 是历史构建产物。为排除"产物滞后于源码"的可能，已用 **`build.gradle` 原文交叉确认**。

### ✅ targetSdk 交叉确认（已消除产物滞后疑虑）
`android/build.gradle:6-8`（**源码，权威**）
```gradle
minSdkVersion = 21
compileSdkVersion = 36
targetSdkVersion = 29
```
`android/app/build.gradle:109-115` 引用 rootProject.ext：
```gradle
compileSdk rootProject.ext.compileSdkVersion
...
minSdkVersion rootProject.ext.minSdkVersion
targetSdkVersion rootProject.ext.targetSdkVersion
```
→ **`packaged_manifests` 里的 `targetSdkVersion="29"` 与源码一致，产物未滞后。**

### 额外发现：`compileSdkVersion = 36` 而 `targetSdkVersion = 29`
- compileSdk **36 = Android 16**，targetSdk **29 = Android 10**，两者相差 **7 个大版本**。
- 这意味着：**用最新的 SDK 编译，却按 Android 10 的行为规则运行**。
  Android 会为该应用开启**大量兼容性 shim（compatibility behaviors）**，
  例如前台服务启动限制、`exported` 语义、隐式 intent 限制、存储权限等
  都退回 29 的宽松语义。
- 这**不是**本次故障的已确认根因，但它显著改变了"哪些系统限制会作用于本 App"的判断，
  是任何后台播放/白屏归因**必须纳入的前提**。
- 佐证：合并清单 L20-21 有两个权限，而 app 自己的 manifest 没有 —— 再次印证
  **只看 app manifest 会误判**。

### 证据优先级
`build.gradle`（源码，权威） ≈ `packaged_manifests`（最终 APK）
> `library src/main/AndroidManifest.xml` > app 的 `src/main/AndroidManifest.xml`（**最不完整**）
- 证据优先级：`packaged_manifests`（最终 APK） > `library src/main/AndroidManifest.xml` >
  app 的 `src/main/AndroidManifest.xml`（**最不完整**，仅含 app 自有声明）。
