# 长时播放假死 / 重开白屏：根因定位与修复（2026-10-27 诊断）

> 现象：移动版长时间听歌后「挂掉」——歌曲不再播放；重新打开 App 一片空白；只能杀进程重开恢复。
> 诊断文件：`lx-diagnostics-2026-10-27T08-22-18-628Z.txt`（App 1.9.1 / versionCode 78003，Xiaomi 25102RKBEC，Android API 37，maxHeapMB=256，largeHeap=false，本轮进程已运行约 8.5 小时）。

## 0. 一句话结论

**播放接近尾声时的「下一首预加载」会对本地 `file://` 音频调用 `checkUrl()`。RN Android 会把非 http(s) 的 fetch 交给 `BlobModule` 把整个音频文件读进内存，随后 `Response.text()` 经 `FileReaderModule.readAsText` 再把整个文件解码成巨量 Java 字符串；大文件（如 20–30MB 的 FLAC）在 256MB 堆上触发 `OutOfMemoryError`。该 `Error` 逃出 `catch (Exception)`，被 RN 包成 `RuntimeException` 后杀死 `mqt_native_modules` 线程，于是所有 JS→原生调用永久排队：播放控制失效、界面不再更新（白屏）、日志不再落盘，只能重启进程恢复。**

这不是「JS 死循环」也不是「播放器被系统冻结」，而是**一次可复现的整文件读取把 RN 原生模块队列线程弄死了**。

## 1. 现场证据（诊断导出）

| 时间 | 事件 | 含义 |
| --- | --- | --- |
| 16:17:05.166 | `[PRELOAD] reset preload info` / 新曲《仰げば尊し》开始 | duration=212.69s（16:20:11 心跳 position=185.53，maxPlayTime=213） |
| 16:20:28 左右 | 预期触发 `preloadNextMusicUrl`（`duration - 10s`，202.69s + 1s 进度轮询） | `preloadNextMusic.ts:95` 的 `duration - progress.nowPlayTime < 10` |
| **16:20:30.031** | **`UNCAUGHT thread=mqt_native_modules type=java.lang.RuntimeException msg=Could not invoke FileReaderModule.readAsText`** | 原生模块队列线程被未捕获异常杀死；栈顶 `JavaMethodWrapper.invoke` |
| 16:20:39.079 / 16:20:41.438 | `TP playback-track-changed track=0 nextTrack=1` → `state=1(STOPPED)` + `playback-queue-ended` | ExoPlayer 播完队列里仅剩的 2 首后停止；JS 已死，没人再 `playNext`/`add` |
| **16:20:42.498** | **`QUEUE_THREAD mqt_native_modules present=0 (previous=1) mqtThreads=mqt_js`** | 线程确认消失，不是暂时阻塞 |
| 16:20:57.501 | `JS_UNRESPONSIVE no JS ack for 28274ms`；`mqt_js` 栈只有 `nativePollOnce`；`nativeModulesThread=0`；`reactInstActive=1`；`javaHeapMB=168` | **JS 线程没卡、也没死，只是「没活干」**：调用通道断了。实例还活着（`reactInstActive=1`），所以重开 Activity 也只能白屏 |
| 16:21:42.512 | 第二次 `JS_UNRESPONSIVE`（73,285ms），`mqtThreads=mqt_js` | 稳定恶化，不会自愈 |
| 16:22:04-16:22:11 | 旧进程 `onCreate` → `onDestroy` → 新进程 `PROCESS start pid=24761` → 正常启动（`home screen pushed`） | 用户「重开」实际经历了旧进程假死 → 被杀 → 新进程启动；新进程启动链路正常 |

补充：崩溃前最后一条已落盘 JS 日志是 16:20:11（心跳 seq=930）；16:20:27 左右的 `[PRELOAD]` 日志因落盘通道随 `mqt_native_modules` 一起失效而丢失（`runtimeLog` 的 flush 依赖原生调用）。这正好解释「日志里看不到崩溃前的最后一步」。

> 判读依据与仓库内《用户排查操作指南》一致：`UNCAUGHT thread=mqt_native_modules` + 栈 ⇒ 异常致死；`nativeModulesThread=0` + JS 栈全 `nativePollOnce` ⇒ 投递通道断掉，而不是 JS 算不过来。

## 2. 代码级根因链（逐环 file:line）

### 2.1 触发：每首歌结束前 10 秒做下一首预加载

`src/core/init/player/preloadNextMusic.ts`（修改前）：

- `:93-105` 监听 `playProgressChanged`，`duration - nowPlayTime < 10` 时调用 `preloadNextMusicUrl`；
- `:46` 对下一首的 URL 做可用性探测：

```ts
const [cached, available] = await Promise.all([isCached(url), checkUrl(url).then(() => true).catch(() => false)])
```

### 2.2 本地歌曲的 URL 是 `file://`

`src/core/music/local.ts:14-17` 返回 `formatLocalFilePathToUrl(path)`；`src/utils/music.ts:18-21` 生成 `file:///storage/emulated/...`。
所以 `checkUrl(url)` 收到的是**本地音频文件路径**，不是 http 地址。

### 2.3 RN 的 fetch 会把响应变成 Blob

`node_modules/whatwg-fetch/fetch.js`（RN 的 `Libraries/Network/fetch.js` 就是它）：

- `:593-600`：只要环境支持 Blob，`fetch` 就对 XHR 设置 `xhr.responseType = 'blob'`；
- `:547`：**对 `file://` 特判，把状态码强行设为 200**：

```js
if (request.url.indexOf('file://') === 0 && (xhr.status < 200 || xhr.status > 599)) {
  options.status = 200;
}
```

这就是为什么日志里 `preload url check ... available=true`：`checkUrl` 以为拿到了 200，实际上这只是 whatwg-fetch 给本地文件的「假装成功」。

### 2.4 `file://` 被 BlobModule 整文件读入内存

- `NetworkingModule.java:276-280`：请求先过 `UriHandler`；
- `BlobModule.java:74-90`：`supports(uri, responseType)` 的条件是 **非 http(s) 且 responseType=blob**，因此 `file://` 命中；
- `BlobModule.java:83` → `:219-232` `getBytesFromUri()`：用 `ContentResolver.openInputStream` + `ByteArrayOutputStream` 把**整个文件**读成 `byte[]`（`:231 return byteBuffer.toByteArray()` 还会再复制一份），存入 `mBlobs`。

注意：这里连 `checkUrl` 的 `method: 'head'` 都不看——`UriHandler` 完全不理会 HEAD，照样整文件读。

### 2.5 `.text()` 把整个文件解码成字符串

`src/utils/request.js:146-194` 的 `fetchData()` 对所有非 binary 响应都调用 `resp.text()`（`:160`）；`checkUrl`（`:196-204`）虽然只需要状态码，也走了这条路。

- `whatwg-fetch/fetch.js:312-326` `Response.text()` → `readBlobAsText()`（`:196-199`）；
- `react-native/Libraries/Blob/FileReader.js:135-150` `readAsText()` → 原生；
- `FileReaderModule.java:37-58`：`blobModule.resolve(...)` 取出整个 `byte[]`（`:47`），然后

```java
promise.resolve(new String(bytes, encoding));   // :55
```

一个 28MB 的 FLAC 会在这里产生约 **56MB 的 UTF-16 字符串**，而 `byte[]` 还同时活着。

### 2.6 OOM 为什么能杀死线程

`FileReaderModule.readAsText` 的 `try/catch` 范围只包了 `new String`（`:54-58`），且是 `catch (Exception)`——**`OutOfMemoryError` 属于 `Error`，捕不到**；`blobModule.resolve` 也不在 try 里。异常从 native 方法里逃出：

- `JavaMethodWrapper.java:371-381`：

```java
try {
  mMethod.invoke(mModuleWrapper.getModule(), mArguments);
} catch (InvocationTargetException ite) {
  if (ite.getCause() instanceof RuntimeException) throw (RuntimeException) ite.getCause();
  throw new RuntimeException(createInvokeExceptionMessage(traceName), ite);  // "Could not invoke ..."
}
```

- 这个 `RuntimeException` 抛在 `mqt_native_modules` 的 Looper 消息里，`Looper.loop()` 不捕获 → 线程 `run()` 退出 → **线程永久消失**（不是 quit，是异常致死）。

**反证价值**：如果底层是普通 `RuntimeException`（比如 NPE），`:378` 会原样 rethrow，顶层类型就会是那个异常本身；而本次顶层是 `RuntimeException` 且 message 是 `Could not invoke FileReaderModule.readAsText`、cause 是 `InvocationTargetException`，说明**底层一定是非 RuntimeException 的 `Error`**——结合代码路径，最合理的就是 `OutOfMemoryError`（也可能是 `StackOverflowError`，但本路径没有深递归）。

### 2.7 之后发生什么（为什么进程还活着、却只能白屏）

`mqt_native_modules` 是 JS→原生调用的执行线程：`TrackPlayer.*`、`NativeModules`、`BackgroundTimer`、日志落盘、`Navigation` 等全部要经过它。线程一死：

- JS 发起的原生调用永远排队、不回包 → `JS_UNRESPONSIVE`（但 JS 线程在 `nativePollOnce` 空转，看起来「活着」）；
- ExoPlayer 在独立原生线程继续把**已经入队的**最后几首播完，然后停在 `queue-ended`；
- React 实例还在（`reactInstActive=1`），但拿不到任何原生回调 → 界面不更新，重开 Activity 也白屏；
- 只能杀进程重启。

**进程为什么没有随线程一起退出**：RN 的默认异常链会把 RuntimeException 原样 rethrow（`DefaultJSExceptionHandler.java:14-21`），异常冒出 `Looper.loop()` 后线程死亡；但本 App 用 `setNativeExceptionHandler(cb, false)`（`src/utils/errorHandle.ts:105-116`，`forceToQuit=false`）注册了「不退出」的处理器。于是：**线程死、进程活**。这正是「App 还在、切回来却一片空白」的直接机制；如果它是 `forceToQuit=true`，现象就会变成闪退/自动重启，而不是白屏。

## 3. 量化：一次预加载分配了多少

以本地库里的文件为例（`E:\WorkSpace\LXMusic\localmusic` 样本：.ogg 平均 8MB、.flac 平均 28MB，最大 29.1MB）：

| 阶段 | 28MB FLAC 的峰值（Java 堆） |
| --- | --- |
| `getBytesFromUri` 读文件 | `ByteArrayOutputStream` 内部缓冲（按倍增可到 ~32MB）+ `toByteArray()` 复制 28MB ≈ **60MB 瞬时** |
| 存入 `mBlobs` | **28MB 常驻**（等 JS GC 触发 BlobCollector 才释放） |
| `readAsText` 解码 | `new String(bytes)` ≈ **56MB** |
| 合计 | 瞬时可达 **80–110MB** |

崩溃时 `javaHeapMB=168 / maxHeapMB=256`（16:20:57），而崩溃前 33 秒（16:19:57）是 **140MB**（diag:657）：**168 − 140 = 28MB**，正好等于「目标 FLAC 的 byte[] 被滞留在 `mBlobs` 里没来得及回收」。在 140MB 基础上再要 80–110MB 的瞬时分配，OOM 完全合理。日志里每次预加载耗时 100–200ms（16:11:51.033、16:13:39.850、16:15:16.419、16:16:55.138），也符合「真的把整个文件读+解码了一遍」，不是一次普通的状态查询。

## 4. 为什么「长时间」才出现、且玩游戏时更容易

- 触发点是**每首歌结束前 10 秒**，长听必然反复遇到；是否炸取决于下一首随机文件多大、当时堆上还剩多少。
- 本地库 7000+ 首、FLAC 与 OGG 混杂，抽到 20–30MB FLAC 时峰值最高；抽到几 MB 的 OGG 时通常能扛过去——所以表现为「偶发」。
- 后台玩游戏会抬高系统内存压力、压缩 App 的可用堆/触发更频繁的 GC，正好提高 OOM 概率（与用户「玩游戏时更容易复现」吻合）。
- 事件流水账里此前只有一次这种 `UNCAUGHT`，说明它稀有但一旦命中就是 100% 假死。

## 5. 修复

### 5.1 根因修复（JS）

1. `src/core/init/player/preloadNextMusic.ts`
   - 本地 `file://` / `content://` URL **不再调用 `checkUrl`**：本地文件是否存在已由 `getMusicUrl`（`core/music/local.ts:14-17` → `utils/music.ts:5-9`）校验；`available` 直接视为 `true`。
   - 保留 `isCached(url)` 与原有 `cached/available` 日志字段、`isLoading` 锁，行为对线上日志可对比。

2. `src/utils/request.js`
   - 新增导出 `isLocalFileUrl(url)`（`/^(file|content):/i`，兼容 `file:/` 与 `file://`）；
   - `checkUrl()` 入口对本地 URL **直接抛错**并注释原因；
   - **`fetchData()` 入口加硬白名单：只允许 `http(s)://`**，其余 URL 直接返回 rejected promise——这样即使未来有人用 `httpFetch/httpGet` 误传本地路径，也不可能再走到「整文件读入 + readAsText」这条路径（native 侧的 `BlobModule`/`FileReaderModule` 本身仍是危险实现，只能从调用侧封死）。

> 修复后：本地预加载只做 `isCached` 检查；`checkUrl` 只服务 http(s)（本仓库当前已无在线源，实际上不再被调用）。
> 注意：本次诊断来自**旧 APK**，新代码必须重新 `assembleRelease` 打包安装后才会生效。

### 5.2 诊断增强（原生）

`android/app/src/main/java/cn/toside/music/mobile/diagnostics/DiagnosticsLog.java` 的 `UNCAUGHT` 钩子原来只打印一层 cause（正好停在 `InvocationTargetException`），导致真正的 OOM 被丢掉。现改为**递归遍历 cause 链**（深度 ≤8、总帧数 ≤160、每层帧数 ≤40/24），并防御自引用 cause / null 堆栈；顶层 `UNCAUGHT` 行格式与末尾转交默认 handler 的语义不变。下次同类问题可直接看到 `caused by java.lang.OutOfMemoryError: ...`，无需再靠推断。

### 5.3 未采纳（建议后续）

- `android:largeHeap="true"`：能把堆上限抬到 ~512MB、降低 OOM 概率，但只是掩盖，不是修复；本次根因修复后暂不需要。
- 桥线程死亡后的自愈/自动重启进程：成本较高，本次未做；现状仍是「必须杀进程重开」。
- 预加载本身对本地文件意义有限（`file://` 不走缓存），后续可评估直接跳过本地文件的预加载。

## 6. 验证记录

| 检查 | 结果 |
| --- | --- |
| `npm run tsc` | 通过（退出码 0） |
| `npx eslint` 两个改动文件 | 通过（退出码 0） |
| `npm run lint`（全量） | 4 条**预存**错误，均在未改动的 `src/core/music/local.ts`（`no-unnecessary-type-assertion`），本次未引入新问题 |
| `npm run build-test` | 通过（Metro bundle 写入成功） |
| `gradlew --offline :app:compileDebugJavaWithJavac` | `BUILD SUCCESSFUL`（Java 诊断改动编译通过） |
| 独立复核 | `.diagnosis/rootcause-file-url-fetch-verify.md`：逐环成立；确认 `src` 内不存在第二条本地 `file://` fetch 路径；确认「顶层 `Could not invoke...` + cause `InvocationTargetException` ⇒ 底层是非 RuntimeException 的 Error」的推断 |

**独立复核提出的不确定点（如实保留）**：
1. OOM 仍是**强推断**而非直接观测（旧版 `UNCAUGHT` 只打一层 cause）；5.2 的改动会在下次复现时直接打出 `caused by java.lang.OutOfMemoryError: Failed to allocate ...`。
2. 那次预加载的目标文件大小没有落盘；28MB 是由 `168 − 140` 的堆增量反推（与本地 FLAC 平均 28MB 吻合），不是直接读取。
3. `queue-ended position=2.198` 与重启后 `duration=2.194` 的细节尚未完全解释（疑似队列里有一个 ~2.19s 的短音频项或 TrackPlayer 的 duration 读取问题），但不影响主链归因：崩栈唯一可能的 JS 调用源是 `fetch(...).text()`，而当时唯一在跑的 fetch 就是 preload 的 `checkUrl`。

**真机验证建议**：重新打包安装后连续播放跨曲 30 分钟以上，确认：`[PRELOAD] preload url check` 依旧出现但 `available=true` 不再伴随 100–200ms 的整文件读取；不再出现 `UNCAUGHT thread=mqt_native_modules`；`QUEUE_THREAD present` 始终为 1。

## 7. 残留风险

- native 侧 `BlobModule.getBytesFromUri` / `FileReaderModule.readAsText` 仍是「整文件读入 + 2×String」且 `catch (Exception)` 不防 OOM；本次已在 `checkUrl` 与 `fetchData` 两层封死入口（只允许 http(s)），但新增「读本地文件」需求时必须走 `react-native-fs` / 原生模块按字节处理，不要用 fetch。
- 本次日志里真正异常类（OOM）仍是强推断，需新版 APK 复现一次确认（5.2 已补 cause 链）。
- `mqt_native_modules` 一旦因任何原因死亡，App 仍不会自愈：`setNativeExceptionHandler(..., false)` 让进程保持「半死」状态，5.3 的进程级恢复/自动重启可作为后续专项。
- 本次修复必须重新打包 APK 才生效；诊断文件来自旧包。

## 8. 关键原始日志行（诊断文件行号）

- `658-671`：`UNCAUGHT thread=mqt_native_modules ... Could not invoke FileReaderModule.readAsText`（含栈与 `caused by InvocationTargetException`）
- `683`：`QUEUE_THREAD mqt_native_modules present=0 (previous=1)`
- `684-694`：第一次 `JS_UNRESPONSIVE` + `mqt_js` 栈（全 `nativePollOnce`）+ `nativeModulesThread=0`
- `794`：心跳 `javaHeapMB=168 maxHeapMB=256 ... nativeModulesThread=0`
- `471-472`：崩溃前最后一次心跳（position=185.53 / duration=212.69 / progressScreenOn=true）
- `677-682`：16:20:39-41 原生播放器 track-changed → STOPPED → queue-ended
- `473-560`：16:22:11 新进程完整启动日志（重开后的正常启动链路）
