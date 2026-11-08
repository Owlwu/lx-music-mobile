# 根因独立验证：file:// fetch → readAsText → OOM → mqt_native_modules 死亡

- 验证人：native-verifier（独立复核，未改任何源码）
- 代码基线：仓库 HEAD `6955ce0e`（对应崩溃 APK versionName=1.9.1）。**工作区已有未提交修复**（`preloadNextMusic.ts` / `utils/request.js` / `DiagnosticsLog.java`，非本次改动），崩溃 APK 对应 HEAD 版本，故下文 src 行号一律标注 HEAD；工作区行号已偏移。
- 诊断文件：`C:\Users\Cocoa\Documents\lx-diagnostics-2026-10-27T08-22-18-628Z.txt`（下称 diag）
- 结论：**支持** 假设链 (a)~(e)，未发现与之矛盾的证据。唯一"不成立"的是任务前提中「DiagnosticsLog 只打印一层 cause」——当前工作区源码已是递归版（§5）。

## 0. 一句话结论

本地歌曲 preload 的 `checkUrl(file://…)` 用 HEAD 请求做"可用性探测"，但 RN 的 `NetworkingModule` 对非 http(s) URL 走 `BlobModule.UriHandler`、**无视 method**把整个音频文件读成 `byte[]` 存入 `mBlobs`，随后 `Response.text()` → `FileReaderModule.readAsText` 的 `new String(bytes, encoding)` 需要约 2 倍文件大小的 UTF-16 `char[]`；在 256MB Java 堆上抛出 `OutOfMemoryError`（`Error`，不被 `catch (Exception)` 捕获）。RN 的 `JavaMethodWrapper` 把它包成 `RuntimeException("Could not invoke FileReaderModule.readAsText")`，而 RN 的默认异常处理链**故意 rethrow**，异常冒出 `Looper.loop()`，`mqt_native_modules` 线程死亡。进程因 app 自配的 UEH（`forceToQuit=false` + handler 内异常被吞）不退出，于是所有 JS→原生调用永久排队：播放控制失效、白屏、只能杀进程。诊断现场与该链条逐项吻合（§1/§4）。

## 1. 逐环核对（成立/不成立/存疑）

### (a) preload 在 duration−10s 触发，对本地歌曲 URL 调 checkUrl —— **成立**

`src/core/init/player/preloadNextMusic.ts`（HEAD）
```
93  const handlePlayProgressChanged = (progress) => {
94    const duration = progress.maxPlayTime
95    if (duration > 10 && duration - progress.nowPlayTime < 10 && !preloadMusicInfo.info) {
103       void preloadNextMusicUrl(progress.nowPlayTime)
```
```
43      const url = await getMusicUrl({ musicInfo: info_.musicInfo }).catch(() => '')
46      const [cached, available] = await Promise.all([isCached(url), checkUrl(url).then(() => true).catch(() => false)])
```
本地歌曲 url 生成链：`src/core/music/index.ts:15` → `src/core/music/local.ts:10-18`
```
14  const path = await getLocalFilePath(musicInfo as LX.Music.MusicInfoLocal)
15  if (path) return formatLocalFilePathToUrl(path)
```
`src/utils/music.ts:18-21`
```
18  export const formatLocalFilePathToUrl = (filePath: string): string => {
19    if (uriSchemeRxp.test(filePath)) return filePath
20    return `file://${filePath.split('/').map(encodeURIComponent).join('/')}`
21  }
```
diag 里每次 preload 的 id 就是 `/storage/emulated/0/Music/local/...`（diag:180-412），URL 形如 `file:///storage/emulated/0/Music/local/%E4%BB%B0...ogg`（diag:471 trackId 内嵌）。

### (b) whatwg-fetch：responseType='blob'；file:// 强制 status=200 —— **成立**

RN 的 `fetch` 就是 whatwg-fetch：`node_modules/react-native/Libraries/Network/fetch.js:17`（`require('whatwg-fetch')`），`Libraries/Core/setUpXHR.js:24-27` 把 fetch/Response 挂到 global。

`node_modules/whatwg-fetch/fetch.js`
```
593    if ('responseType' in xhr) {
594      if (support.blob) {
595        xhr.responseType = 'blob'
...
540    xhr.onload = function() {
545      // This check if specifically for when a user fetches a file locally from the file system
547      if (request.url.indexOf('file://') === 0 && (xhr.status < 200 || xhr.status > 599)) {
548        options.status = 200;
...
553      var body = 'response' in xhr ? xhr.response : xhr.responseText
554      setTimeout(function() { resolve(new Response(body, options)) }, 0)
```
`support.blob` 在 RN 恒为 true（`FileReader`/`Blob` 已 polyfill，fetch.js:9-25、setUpXHR.js:29-31）。

为什么 `xhr.status` 是 0：RN 的 XHR 初始 `status=0`（`Libraries/Network/XMLHttpRequest.js:159`）；`NetworkingModule` 的 UriHandler 分支只发 `didReceiveNetworkData` + `didCompleteNetworkResponse`，**不发** `didReceiveNetworkResponse`（`ResponseUtil.java:59-78, 96-105`；对照 `NetworkingModule.java:276-283`），所以 `__didReceiveResponse` 从不执行、status 保持 0 → 被 545-551 强制成 200。

**这点被 diag 反向证实**：所有 file:// preload 都记录 `available=true`（diag:184、293、353、411），因为 200 是 fetch 自己伪造的，与文件是否真的可读无关。

### (c) NetworkingModule → BlobModule.UriHandler → getBytesFromUri 整文件读入 mBlobs —— **成立**

`node_modules/react-native/ReactAndroid/.../modules/network/NetworkingModule.java`
```
272      Uri uri = Uri.parse(url);
275      // Check if a handler is registered
276      for (UriHandler handler : mUriHandlers) {
277        if (handler.supports(uri, responseType)) {
278          WritableMap res = handler.fetch(uri);
279          ResponseUtil.onDataReceived(reactApplicationContext, requestId, res);
280          ResponseUtil.onRequestSuccess(reactApplicationContext, requestId);
281          return;
```
注意：handler 在 OkHttp 之前、**完全不看 method**（`fetch(uri)` 只接收 uri），所以 `checkUrl` 的 `method:'head'` 不能阻止读全文件（request.js HEAD:197）。

`.../modules/blob/BlobModule.java`
```
47   private final Map<String, byte[]> mBlobs = new HashMap<>();
74       public boolean supports(Uri uri, String responseType) {
75         String scheme = uri.getScheme();
76         boolean isRemote = "http".equals(scheme) || "https".equals(scheme);
78         return (!isRemote && "blob".equals(responseType));
82       public WritableMap fetch(Uri uri) throws IOException {
83         byte[] data = getBytesFromUri(uri);
86         blob.putString("blobId", store(data));
...
219    private byte[] getBytesFromUri(Uri contentUri) throws IOException {
220      InputStream is = getReactApplicationContext().getContentResolver().openInputStream(contentUri);
226      ByteArrayOutputStream byteBuffer = new ByteArrayOutputStream();
227      int bufferSize = 1024;
230      while ((len = is.read(buffer)) != -1) byteBuffer.write(buffer, 0, len);
233      return byteBuffer.toByteArray();
```
`store(data)` → `mBlobs.put(blobId, data)`（:165-175）。JS 侧 `xhr.response` 用该 blobId 造 Blob（`XMLHttpRequest.js:245-247` → `BlobManager.createFromOptions`），`Response.text()` 再把它交给 FileReader。

### (d) Response.text() → FileReader.readAsText → FileReaderModule.readAsText → new String；catch 只捕 Exception —— **成立**

`whatwg-fetch/fetch.js`
```
312    this.text = function() {
318      if (this._bodyBlob) {
319        return readBlobAsText(this._bodyBlob)
...
193  function readBlobAsText(blob) {
194    var reader = new FileReader()
196    var match = /charset=([A-Za-z0-9_-]+)/.exec(blob.type)
197    var encoding = match ? match[1] : 'utf-8'
198    reader.readAsText(blob, encoding)
```
`node_modules/react-native/Libraries/Blob/FileReader.js`
```
135  readAsText(blob: ?Blob, encoding: string = 'UTF-8'): void {
144    NativeFileReaderModule.readAsText(blob.data, encoding).then(
```
`.../modules/blob/FileReaderModule.java`
```
36   @Override
37   public void readAsText(ReadableMap blob, String encoding, Promise promise) {
46     byte[] bytes =
47         blobModule.resolve(blob.getString("blobId"), blob.getInt("offset"), blob.getInt("size"));
54     try {
55       promise.resolve(new String(bytes, encoding));
56     } catch (Exception e) {
57       promise.reject(e);
58     }
```
`BlobModule.resolve`（:199-213）在 `offset==0 && size==data.length` 时**不拷贝**，直接返回 mBlobs 里的数组——所以 byte[] 只有一份，但 `new String` 会新分配 `char[]`。
`catch (Exception)` 捕不到 `OutOfMemoryError`（`Error` 子类），异常直接冒出该方法。

### (e) RuntimeException 包装 → Looper 线程死亡 → JS→原生永久排队 → 半死 —— **成立**

`.../bridge/JavaMethodWrapper.java`
```
371      try {
372        mMethod.invoke(mModuleWrapper.getModule(), mArguments);
373      } catch (IllegalArgumentException | IllegalAccessException e) {
374        throw new RuntimeException(createInvokeExceptionMessage(traceName), e);
375      } catch (InvocationTargetException ite) {
378        if (ite.getCause() instanceof RuntimeException) {
379          throw (RuntimeException) ite.getCause();
381        throw new RuntimeException(createInvokeExceptionMessage(traceName), ite);
392    return "Could not invoke " + traceName;
```
diag 的 `msg=Could not invoke FileReaderModule.readAsText` + `caused by java.lang.reflect.InvocationTargetException`（diag:658-670）**只可能**来自 :381 这条包装分支（见 §1.1 推论确认）。

线程死亡链（全部来自 node_modules，release 默认路径）：
- `MessageQueueThreadHandler.java:26-42`：`dispatchMessage` 只 `catch (Exception)`，RuntimeException 被交给 `mExceptionHandler`；
- `CatalystInstanceImpl.java:626-634` → `onNativeException`（:613-614）→ `mJSExceptionHandler`；
- `ReactInstanceManager.java:1327-1339`：`mJSExceptionHandler` = `mDevSupportManager`（release 即 DisabledDevSupportManager）；
- `DisabledDevSupportManager.java:193-196` → `DefaultJSExceptionHandler.handleException`；
- `DefaultJSExceptionHandler.java:14-21`：`if (e instanceof RuntimeException) throw (RuntimeException) e;` —— **原样 rethrow，栈帧保留**（与 diag 栈顶 `JavaMethodWrapper.invoke` 一致）；
- 异常冒出 `MessageQueueThreadHandler.dispatchMessage` → `Handler.dispatchMessage` → `Looper.loop`（diag:662-669），而 `Looper.loop()` 在 `MessageQueueThreadImpl.java:226-235` 无 try/catch → `Thread.run()` 结束，线程死亡；
- 之后投递：`MessageQueueThreadImpl.runOnQueue`（:56-68）只检查 `mIsFinished`（只有正常 quit 才置位），异常死亡不会置位 → 后续 Runnable 继续被 post 到无人 drain 的 Looper → **永久排队**。
- RN 的 `onNativeException` 里本来还会 `destroy()`（:615-623），但 `handleException` 先抛了，所以连 destroy 都没执行 → JS 线程/实例保留，形成"活着但半死"。

进程为何不退出（关键）：`android/.../diagnostics/DiagnosticsLog.java` 给 `mqt_*` 线程挂的 `UNCAUGHT_LOGGER` 只落盘、不 kill（当前源 :1530-1589，HEAD :1530-1569），随后转交默认 handler；而 app 自己把默认 handler 配成"不退出"：`src/utils/errorHandle.ts:105-116` `setNativeExceptionHandler(cb, false)` → `node_modules/react-native-exception-handler/index.js:28-38`（第二参 forceApplicationToQuit=false，第三参 executeDefaultHandler 默认 false）→ `ReactNativeExceptionHandlerModule.java:33-73`：`executeOriginal=false / forceToQuit=false` 时不 `System.exit`。若此时 `getCurrentActivity()` 为 null（后台播放，diag 显示 activities=0、appState=background），handler 内 `i.setClass(null,…)` 会抛 NPE，被 DiagnosticsLog 的 `catch (Throwable)`（:1585）吞掉。→ **线程死、进程活**，与 diag 完全一致。

#### 1.1 推论确认：底层不是 RuntimeException，而是 Error（最可能 OOM）

- `msg` 精确等于 `createInvokeExceptionMessage`（JavaMethodWrapper:392-394），说明走的是 :381 包装分支；:378-379 明确：若 cause 是 RuntimeException 就原样 rethrow（那样 msg 会是 NPE/IllegalArgument 等原文，不会是 "Could not invoke …"）。
- cause 是 `InvocationTargetException`（diag:670 只打了一层），其 target 就是模块方法抛出的真实 throwable。
- `FileReaderModule.readAsText` 的 try/catch 覆盖所有 Exception（含 UnsupportedEncodingException、RuntimeException），`resolve` 也不抛受检异常 → 唯一能逃逸的是 **Error**。没有递归 → StackOverflowError 不合理；编码 `utf-8` 合法 → 只剩 `OutOfMemoryError` 最合理（`NoClassDefFoundError` 之类无证据）。
- **结论：该推论成立**（强推断，非直接观测；旧版 UNCAUGHT 只打一层 cause，正是缺了 OutOfMemoryError 这一行）。

## 2. 反证检查

### 2.1 除 preload 外，还有谁会 fetch 本地文件 / .text() 读整个文件？

全仓 grep（`src/`）结果：

| 调用点 | 用途 | 是否可能读本地文件 |
|---|---|---|
| `src/utils/request.js:157-160` `global.fetch(...).then(resp => options.binary ? resp.blob() : resp.text())` | 通用请求封装 | 是——唯一危险点；但唯一使用者是 `checkUrl`（:196-204），`httpFetch`(:17)/`httpGet`(:46) 全仓无调用者 |
| `src/plugins/sync/client/utils.ts:11,16` `fetch(url)` + `response.text()` | 同步服务端 | 否，url 来自同步配置（http/https） |
| `src/components/common/ImageBackground.tsx:98-100` `Image.prefetch(url)`；`src/core/init/common.ts:20` | 封面预热 | 否，走 Fresco 原生图片加载，不经过 whatwg-fetch/FileReader |
| 其它 `readPic/readLyric`（`localMediaMetadata.ts:57-63,110-113`） | 内嵌歌词/封面 | 读文件但不是 fetch/FileReader.text() 路径，且只读小段元数据 |

**结论：src 里除 preload→checkUrl 之外，没有第二条会 `fetch(file://).text()` 的路径。** 本次崩栈是 `FileReaderModule.readAsText`，JS 侧唯一调用者是 whatwg-fetch 的 `readBlobAsText`（只有 `Response.text()` 用），而 `fetchData` 的 `.text()` 只可能由 `checkUrl` 触发 → 归因唯一。
（`blobToBuffer` 用的是 `readAsDataURL`，native 方法是 `readAsDataURL`，与崩栈不符，已排除。）

### 2.2 BlobModule.mBlobs 何时释放？会不会累积？

- 存入：`BlobModule.java:165-175`（无容量上限、无 TTL）。
- 释放有两条路：
  1. **JS GC**：`BlobManager.createFromOptions` 给每个 Blob 挂 `__collector`（`BlobManager.js:111-126`；provider 由 `BlobModule.java:146-148` → `BlobCollector.cpp:35-58` 安装）。JS Blob 被 Hermes 回收时，HostObject 析构直接 JNI 调 `BlobModule.remove(blobId)`（`BlobCollector.cpp:26-33`）→ `mBlobs.remove`（`BlobModule.java:177-182`）。
  2. **显式 close**：`Blob.close()`（`Blob.js:137-141`）→ `BlobManager.release`（`BlobManager.js:131-139`）→ `NativeBlobModule.release` → `BlobModule.release`（:372-374）。**whatwg-fetch/XHR/fetchData 都不调用 close()**。
- 因此：**正常路径下不泄漏，但释放时机完全取决于 Hermes GC**；一次 preload 就压入一个整文件 `byte[]`（1~28MB），在下一次 Hermes GC 前可跨多次 preload 累积；mBlobs 本身不受 Java 堆压力驱动（Hermes 不知道 Java 堆），只在 JS 堆有压力时才回收 → 长时间后台播放（JS 几乎不分配）时累积风险更高。
- 额外小泄漏：`BlobRegistry.js` 的 Map 只在 `BlobManager.release`（close）里 unregister，GC 路径绕过它 → 每个 blob 留一个 uuid 字符串（量级很小，不是本次主因）。
- 本次崩溃后：`readAsText` 的 Promise 永远不会 settle（线程死了），`await` 链与原生 mBlobs 引用一起滞留；JS 线程空闲不再 GC → 那个 `byte[]` 在进程剩余生命周期内不释放。这与 diag:685 的 `javaHeapMB=168`（崩溃前 16:19:57 是 140，diag:657）自洽：**+28MB ≈ 被滞留的目标文件 byte[]**。

## 3. 内存测算（28MB FLAC）

以 28MiB = 29,360,128 B 为例（Java 堆，max=256MB，largeHeap=false，diag:565/657/685 与 PROCESS 行）：

| 项 | 大小 | 说明 |
|---|---|---|
| mBlobs 里的 `byte[]` | 28 MiB | `getBytesFromUri` 的 `toByteArray()` 结果，常驻直到 GC/remove |
| `ByteArrayOutputStream` 峰值 | 32 MiB + 28 MiB（≈60） | 1KB buffer 倍增到 2^25B，`toByteArray` 再复制一份；调用返回后成垃圾，但**可能尚未被 GC** |
| `new String(bytes,"utf-8")` 的 `char[]` | ~52–56 MiB | Android `String` 为 UTF-16 `char[]`；FLAC 是二进制，非法 UTF-8 序列多 → 替换字符 U+FFFD 基本 1 char/byte → chars≈bytes，×2 字节 |
| 峰值合计（相对基线） | **84 ~ 116 MiB** | 84（不含 BAOS 垃圾）~116（含） |
| 崩溃前 Java 堆基线 | 140 MiB | diag:657（16:19:57，崩溃前 33s） |
| 峰值后 Java 堆 | **224 ~ 256+ MiB** | 对照 `maxHeapMB=256` → **临界/越界，OOM 合理** |
| 崩溃后实测 | 168 MiB | diag:685 = 140 + 28（byte[] 滞留，char[] 未分配成功/已回收） |

成功路径才会发生的 JS 侧副本（本次没走到，因为 `new String` 先 OOM）：bridge 传输会再生成 ~28MiB 的 native UTF-8 `std::string`，Hermes 侧 `jsi::String` 约 56MiB（替换字符非 ASCII，1-byte string 优化不适用）→ 再加 ~84MiB（跨 native/JS 堆）。**即使 Java 侧侥幸成功，JS 侧也接近危险线**；这解释了为何该实现必须移除，而不只是"偶尔崩"。

**为什么不是每次必现：**
1. 阈值 ≈ 3× 文件大小 + 基线堆（1 份 byte[] + 2 份 char[]）。几 MB 的 ogg 只需十几 MB，日志里 16:13:39 / 16:15:16 / 16:16:54 的 preload 全部成功（elapsed 184/236/244ms，diag:294/354/412），16:11:50 甚至成功读了一个 FLAC（346ms，diag:185）。
2. 播放模式是 random（diag:16 `player.togglePlayMethod:"random"`）→ 下一首文件大小随机；随机歌曲库里 FLAC 很多（导入 7395 首，diag:1729）。
3. 基线堆随会话漂移（日志缓冲、列表、图片、之前未及时 GC 的 blob），长时间后台播放逐步抬高，"长时间听歌后偶发"符合预期。
4. **存疑**：目标文件真实大小没有落盘（见 §4）；28MB 来自"堆增量 + 假设"。若实际文件 <20MB，则单靠"3×"不足，需要额外保留内存（例如前面 preload 的 blob 未回收）来解释——但 168−140=28MB 与"目标≈28MB"高度自洽。

## 4. 时间线核对

- 当前曲《仰げば尊し》16:17:05.464 `Playing`（diag:453-454），`duration=212.69`、16:20:11.613 `position=185.53`（diag:472）。
- 触发阈值 `duration−10 = 202.69s` → 16:17:05.46 + 202.69 = **16:20:28.15**；进度轮询 1s（diag:458 polling intervalMs=1000），实际 preload 启动 ≈16:20:28.2–29.2。（lead 给的 16:20:27.7 与按 position=185.53 推算的 16:20:28.1 相差 <0.5s，属同一时刻的取整差异，**吻合**。）
- 同路径历史耗时：`getNextPlayMusicInfo` 43–203ms，`getMusicUrl` + `isCached/checkUrl` 合计 184–346ms（diag:185/294/354/412）。本次 checkUrl 要读 28MB（比小 ogg 慢），1~2s 内到 `readAsText` 是合理的。
- **16:20:30.031** diag:658 UNCAUGHT（`Could not invoke FileReaderModule.readAsText`）——距 preload 启动 ≈1–2s，**吻合**。
- 崩溃前最后一次 JS ack：`lastAckAtUptimeMs=33711956`，按 UNCAUGHT 的 uptimeMs=33712761 反推 ≈16:20:29.226（diag:684）→ JS 在 16:20:29.2 还活着，0.8s 后崩，与 checkUrl 正在读文件吻合。
- 16:20:38.15 当前曲自然播完（16:17:05.46+212.69）；16:20:39–41 原生 TP `playback-track-changed` / `queue-ended`（diag:675-682），之后**不再有播放**——因为 JS 补下一首的 TrackPlayer 调用全部排队不执行。
- 16:20:42.498 `QUEUE_THREAD present=0`（diag:683）、16:20:57 `JS_UNRESPONSIVE` 且 `mqt_js` 卡在 `nativePollOnce` 空转（diag:684-693，JS 线程没死也没忙，只是它的 ack 调不到原生）→ 与"原生队列线程死亡"完全一致，而不是"JS 死循环/卡死"。
- 16:21:42 仍 `nativeModulesThread=0`（diag:1712）；16:22:04 重开 Activity（diag:1713）但仍是半死实例 → 16:22:08 用户杀掉（onDestroy），16:22:09 新进程（diag:1719-1720），16:22:11 正常 BOOT（diag:473-562）。**与"重开空白、杀进程恢复"完全一致。**
- 16:20:27–30 的 PRELOAD 日志缺失是**预期**：`runtimeLog` 批量落盘 `flushInterval=2000ms`（runtimeLog.ts:52-53），经 `appendFile → FileSystem` 原生模块（fs.ts:66）写盘；线程 16:20:30.03 死亡时这批日志还在 JS 缓冲里，跨桥写盘永不执行。

### 4.1 一个未解释的细节（存疑，不影响主链）

16:20:41.438 `queue-ended ... position=2.19799995`（diag:681-682）与重启后 live state `native player duration=2.194`（diag:15）数值几乎相同，怀疑原生队列里存在一个 ~2.19s 的短音频项（或这是 TP 的错误 duration），但两处语义尚未核对清楚。它不影响崩溃归因（崩栈唯一可能来源是 `fetch(...).text()`，而 16:20:28–30 唯一在跑的 fetch 是 preload 的 checkUrl）。

## 5. DiagnosticsLog UNCAUGHT handler：现状与修改建议（只建议，未改）

**现状澄清**：当前工作区源码**已经是递归打印 cause 链**（`MAX_CAUSE_DEPTH=8`、`MAX_CAUSE_FRAMES=160`，见 1549-1568），任务描述里"只打印 throwable.getCause() 一层"对应的是 **HEAD 版本**（1530-1569，diag:670 的"caused by InvocationTargetException"后无堆栈即是该版本）。所以：
- 若工作区改动是计划内的 → 该需求已满足（诊断下次会打出 `caused by java.lang.OutOfMemoryError: Failed to allocate ...`，这正是本次缺失的决定性证据）；
- 若并非计划内 → 需要明确保留，且**必须重新构建 APK 才会生效**（当前 diag 来自旧版）。

在现有实现上建议的加固（仍不改）：
1. 每一层的 `getStackTrace()/clipTo()/String.valueOf(frames[i])` 包进**独立 try/catch**，某层打印失败不影响后续层（现在整段共用一个外层 catch，任一环出问题会丢掉后面的层）。
2. 用 `IdentityHashMap<Throwable,Boolean>` 防 cause 环；现有 `next == cursor` 只防自引用，A→B→A 这种环会靠深度上限兜底（可接受，但显式更稳）。
3. OOM 现场最值钱的是内存数字：在 UNCAUGHT 分支里补一行 `Runtime.getRuntime()` 的 `total/free/max`（以及 `Debug.getNativeHeapAllocatedSize()`），并用 `Log.getStackTraceString`/`throwable.getMessage()` 保留 `Failed to allocate N-byte allocation` —— OOM 的 message 自带失败尺寸，可直接验证 §3 的测算。
4. 递归本身对 OOM 是安全的（OOM 时分配字符串可能再失败，但外层 catch(Throwable) 保证不反噬崩溃流程；帧上限 160 已够）。**不建议**在这里主动 killProcess —— 是否保留"半死态"是产品决策，见下条。

**附带风险（建议 lead 决策）**：`errorHandle.ts:105-116` 的 `setNativeExceptionHandler(cb, false)` 决定了队列线程死后**进程不退出**，这是"白屏但仍存活"的直接原因；DiagnosticsLog 的 catch(Throwable) 又吞掉了 fallback handler 可能的 NPE。如果目标是"崩溃即重启"，需要 `forceToQuit=true` 或在该 UNCAUGHT 钩子里主动 `Process.killProcess`；如果目标保留现状，则至少要在检测到 `mqt_native_modules` 消失时自愈（重建 bridge / 提示重启），而不仅是记录。

## 6. 结论与不确定点

**结论：支持** 根因链 (a)~(e)，且 (e) 中"线程死、进程活"的机制也已用源码闭环（RN 默认 rethrow + app 自配 `forceToQuit=false`）。这不是"JS 卡死"，而是**JS 侧一切尚好、原生模块队列线程被 OOM 异常杀死**导致的全量 JS→原生调用黑洞。

**不确定点（按重要性）：**
1. **OOM 是推断，不是直接观测**：旧版 UNCAUGHT 只打一层 cause（diag:670），`OutOfMemoryError` 没进日志。依据是 `JavaMethodWrapper:378-381` 的包装规则 + `FileReaderModule:56` 的 `catch(Exception)` 排除法（§1.1），逻辑上很硬，但仍建议新版 APK 复现一次，确认 `caused by java.lang.OutOfMemoryError` 及其 "Failed to allocate …" 尺寸。
2. **目标文件真实大小未知**（那次 preload 的 id/大小没落盘）。28MB 来自堆增量（168−140）与假设；按 28MB 计 OOM 属"临界但合理"（224–257MB vs 256MB），若有其它保留内存（之前未 GC 的 blob、BAOS 垃圾）则更稳。
3. §4.1 的 2.19s 现象未解释（可能涉及队列中的一个短音频项），留待后续核对 TP 事件语义。
4. 若将来证实底层 Error 不是 OOM（例如某种 `NoClassDefFoundError`），(d) 的结论需要改写；但在 `readAsText` 的代码路径上没有别的解释空间。
5. 反证已做：src 中不存在第二条本地 `fetch(file://).text()` 路径；`blobToBuffer`(readAsDataURL) 与崩栈不符已排除。

## 7. 工作区现有修复的复核（非本次改动，供定稿参考）

- `src/utils/request.js`：新增 `isLocalFileUrl()`（`/^(file|content):\/\//i`），`checkUrl` 对本地 URL 直接 `throw`，不再发 HEAD。
- `src/core/init/player/preloadNextMusic.ts`：本地 URL 时 `available` 直接用 `Promise.resolve(true)`（本地文件存在性已由 `getMusicUrl → getLocalFilePath` 校验）。
- 复核：这两处**能切断本次崩溃路径**；本地 URL 被 `getMusicUrl` 判空后不会再有 checkUrl 调用，行为兼容（`available=true` 与旧日志一致）。
- 残余风险：native 侧 `FileReaderModule.readAsText` / `BlobModule.getBytesFromUri` 仍是"整文件读入 + 2×String"且 `catch(Exception)` 不防 OOM；**任何未来新增的 `fetch(file://).text()` 都会复现本崩溃**。建议在 `fetchData/httpFetch` 层加"非 http(s) 禁止 text()/blob-to-text"的硬白名单（或尺寸守卫），而不仅靠 preload 一处修补。`httpFetch/httpGet` 目前全仓无调用者，可考虑删除以缩小暴露面。

---
*本报告只读源码与诊断文件，未修改 src/android/node_modules；除本文件外未写任何文件。*
