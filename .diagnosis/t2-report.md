# T2 报告：移动版运行时日志基础设施

**任务**：task-2 — 设计并实现移动版运行时日志埋点核心模块
**负责人**：logcore
**工作目录**：`E:\WorkSpace\LXMusic\lx-music-mobile`

## ⚠️ 验收状态（必读）

**`npx tsc --noEmit` 与 `npx eslint` 未能运行。**

本会话的 `pwsh` 工具**完全不可用**：任何命令（包括 `Write-Output 'x'`）都返回

```
Error: sandbox-local windows-acl temp grant materialization failed and its cleanup also failed
```

已确认的事实：

- 与工作目录无关：在 `E:\WorkSpace\LXMusic\lx-music-mobile`、`E:\WorkSpace\LXMusic`、`C:\Users\Cocoa` 三处执行最简命令均同样失败 → **会话级沙箱 ACL 故障，不是代码或路径问题**。
- 全队 4 人独立确认同样故障（logcore / recon / verifier / lead）。
- 按 skill `diagnose-windows-sandbox-acl` 的规定，以一次调用运行其诊断+修复脚本，先后以 `danger-full-access` 与 `workspace-write` 申请权限，**两次都被自动拒绝**（本会话审批提示已禁用）。按 skill 规则已停止重试，未做任何绕过。
- lead 随后在获得批准后自行运行了该脚本：VERDICT=`NOT_THIS_CLASS` —— `E:\WorkSpace\LXMusic` 自身的 WRITE_DAC/WRITE_OWNER 正常且不含沙箱包授权项；真正断点在**祖先目录** `E:\WorkSpace` 与 `E:\`（owner 为另一 SID 且当前用户无 WRITE_DAC/WRITE_OWNER），沙箱无法在其上落地临时授权。技能规定不得向上扩大 `-AllowRoot`、不得手工改权限，故停止。
- **lead 已正式豁免 task-2 的 tsc/eslint 验收项**，改以静态审查替代。

**因此本报告不声明 tsc/eslint 通过。** 编译与 lint 结论**待有可用 shell 的环境复核**。

**复核命令**（工作目录 `E:\WorkSpace\LXMusic\lx-music-mobile`）：

```powershell
npx tsc --noEmit 2>&1 | Select-Object -First 60
npx eslint src/utils/runtimeLog.ts src/utils/stallWatchdog.ts src/utils/log.ts
```

**既有错误基线**：因 tsc 无法运行，**未能取得基线**，故无法区分"既有错误"与"新增错误"。

## 现行类型自查（替代编译器的静态核对）

因 tsc 不可用，我对三个文件做了逐行自查，覆盖以下不变量：

| 自查项 | 结论 |
|---|---|
| import 路径存在且导出名匹配 | `@/utils/fs` 的 `appendFile/existsFile/readFile/stat/temporaryDirectoryPath/unlink/writeFile` 均存在于 `fs.ts`（L36/60/43/40/20/36/64） |
| `stat()` 返回字段名 | `react-native-file-system/lib/typescript/src/index.d.ts:16` 定义 `FileType.size: number`；`readSize` 用 `info.size ?? 0` ✅ |
| 已移除的导入无残留引用 | `moveFile`、`rename` 已从 import 与全部调用点移除（grep 确认 0 残留） |
| 每个 `const` 箭头函数的声明/使用顺序 | `stringifyArg`(112) → `safeMoveFile`(245) → `rotateFile`(268) → `readSize`(302) → `utf8ByteLength`(322) → `doFlush`(346) → `pushEntry`(416)。前向引用仅出现在**函数体内部**、运行时才执行，无 TDZ 问题 |
| `safeRun` / `safeRunAsync` 定义先于使用 | `safeRunAsync`(≈69)、`safeRun`(≈83)，均早于所有公开导出 |
| 所有公开导出签名与调用方一致 | `log.info/warn/error(...msgs: any[])`、`init()`、`getLogs()`、`clearLogs()` 与原实现**逐字一致** |
| `RuntimeLogLevel` 类型导出一致 | `log.ts` 以 `type RuntimeLogLevel` 导入，`runtimeLog.ts` 以 `export type` 导出 ✅ |
| 无未使用的导入/变量 | `info`/`warn`/`error` 在 `log.ts` 改为 `info as runtimeInfo`（因 `log` 对象方法同名会遮蔽，必须别名） |
| `no-floating-promises`（standard-with-typescript 默认启用） | 所有 async 调用均 `await` 或 `void`；定时器回调内用 `void flush()` |
| `flushSyncBestEffort` 返回类型变更的传播 | `runtimeLog` 聚合对象与 `log.ts` 的 `flushLogsSyncBestEffort` 均已同步为 `Promise<void>` |
| 无新增 npm 依赖 | `utf8ByteLength` 为手写实现，未引入 `@craftzdog/react-native-buffer` |

**仍需人工确认**：以上为静态推理，**不能替代 tsc 的真实类型检查**。

## 交付文件

| 文件 | 类型 | 说明 |
|---|---|---|
| `src/utils/runtimeLog.ts` | 新建 | 运行时日志核心：多等级、环形缓冲、批量 flush、轮转、静默降级、内存采样 |
| `src/utils/stallWatchdog.ts` | 新建 | JS 线程心跳看门狗 + 关键事件标记 |
| `src/utils/log.ts` | 改造 | 兼容层，保留全部原有导出，内部转接 runtimeLog |

未改动任何其他文件，未引入新 npm 依赖。

## 一、对需求要点的实现

| 需求 | 实现 |
|---|---|
| 多等级 debug/info/warn/error | `levelWeight` 分级 + `minLevel` 过滤，低于等级直接丢弃（不入内存、不写盘） |
| 时间戳含毫秒 | `formatTimeText()` → `YYYY-MM-DD HH:mm:ss.SSS` |
| tag 与结构化字段 | 每条格式为 `时间 LEVEL [TAG] message k=v`；约定**最后一个纯对象参数**自动转结构化字段 |
| 内存环形缓冲（默认 1000） | `state.entries`，超出即 `splice` 丢最旧；`getSnapshot()`/`getEntries()` 导出 |
| 批量 flush（≥20 条或 ≥2s） | `pushEntry` 达 `flushBatchSize` 立即 `flush()`，否则 `scheduleFlush()` 定时器；避免逐条 `appendFile` 的 IO 抖动 |
| 轮转（512KB，2 个备份） | `rotateFile()`：`runtime.log → .1 → .2`，超出删最旧；`currentSize` 免重复 `stat` |
| 写失败静默降级 | 全部 IO 走 `try/catch` + `.catch(() => {})`；`safeRun`/`safeRunAsync` 包裹所有公开入口；写失败内容放回队列下轮重试，且只 warn 一次防刷屏 |
| init 之前可安全调用 | 未就绪时只进内存队列；`init` 后 `await flush()` 回灌（与 bootLog 模式一致）；**init 幂等** |
| flush / flushSyncBestEffort / getSnapshot / clear / setLevel | 全部提供 |
| error.log 无限增长 → 轮转 | `rotateLegacyFileIfNeeded()` + `legacyPending` 通道，旧文件同样按 512KB 轮转 |
| 看门狗（5s 心跳 / 20s 阈值） | `stallWatchdog.start()`：普通 `setInterval` 打点，`elapsed > stallThreshold` 即判卡死 |
| markEvent 记录最近关键事件 | `recentEvents` 环形缓冲（保留 20 条），STALL 时附上**最后一条事件 + 最近 5 条**一起写日志，并立即 `flushSyncBestEffort()` |
| recordMemory 内存采样 | 优先 `global.performance.memory`；不可用时 **no-op + 仅 warn 一次**；另提供 `startMemorySampling()` 周期采样 |

## 四、审查发现与修复记录

verifier 与 lead 对初版做了独立逐行审查，提出 2 CRITICAL + 2 MEDIUM + 2 LOW。**我逐条自行复核了原始证据**（读原生 Java 源码 / 确认 `String.length` 语义），全部属实，已全部修复：

| 编号 | 问题 | 证据 | 修复 |
|---|---|---|---|
| CRITICAL-1 | 轮转阈值把**字符数**当**字节数**，512KB 实际可长到 ~1.5MB（中文 3 字节/字符），等于没修掉"无限增长" | `String.length` 是 UTF-16 码元数 | 新增 `utf8ByteLength()`（按码点统计，含代理对 4 字节）；runtime 通道改用真实字节数 |
| CRITICAL-1b | legacy 通道用 `legacyText.length` 与阈值比较 —— 比的是**本批长度**而非**文件总大小**，几乎永不触发轮转 → `error.log` 退化为无限增长 | 纯逻辑错误 | 改为 `await readSize(legacy)` 取真实文件大小再比较，与 runtime 通道口径一致 |
| CRITICAL-2 | 轮转用 `moveFile`(=`FileSystem.mv`)，原生层 `renameTo` 失败时**丢弃返回值并无条件删源文件** → 日志被静默销毁且 JS 无感知 | `FsFile.java:145` `this.file.renameTo(desFile);`（返回值丢弃）、`:156` `this.file.delete();`（无条件删源） | 新增 `safeMoveFile()`：`readFile` → `writeFile` → **校验目标大小一致** → 才 `unlink` 源；任一步失败保留源文件并记 warn |
| MEDIUM-1 | `flushSyncBestEffort` 名不副实，`void doFlush()` 不等待 → 崩溃时恰在最需要日志时丢失 | 跨桥 `await appendFile` 无法在同步栈完成 | 改为返回 `Promise<void>`（可 await 真正落盘）；JSDoc 明确写"**不保证一定落盘**，best effort 的固有限制" |
| MEDIUM-2 | `getSnapshot` / `getEntries` 是仅有的无 `safeRun` 保护的导出，却被"App 已不正常"路径调用 | 违反本模块自述的静默降级原则 | 两者均包 `safeRun`，失败返回 `''` / `[]` |
| LOW-1 | `markEvent` 的 `detail` 存**对象引用**，20 个引用长期阻止 GC —— 在"内存压力"正是根因的场景里看门狗自己成泄漏源 | — | 新增 `sanitizeDetail()`：只留标量、字符串截断 200 字符、对象浅拷贝且限 20 项/层 |
| LOW-2 | `startMemorySampling` 的停止函数无调用点，`setInterval` 永不停 | — | JSDoc 加 ⚠️ 强制说明调用方必须保存并使用停止函数；补 `.unref()` |
| CRITICAL-3（lead 发现） | `rotateFile` 在 `safeMoveFile` **返回 false 时仍无条件 `writeFile(path, '')` 清空主文件**，而旧备份已在前面被 `unlink` → 出现"新旧日志同时消失"的新丢数据路径 | `runtimeLog.ts` 原 `:285-291` 控制流 | 改为**条件清空**：只有搬运成功才 `unlink` 主文件并重建空文件；搬运失败则保留原文件、放弃本次轮转。JSDoc 写明取舍 |

另外两处由**我自己**在实现中发现并规避的缺陷（tsc/eslint 均查不出）：

1. **`FileSystem.rename` 的第二参数是"同目录新文件名"，不是目标路径。**
   原生 `FsFile.java:114`: `rename(name) => renameTo(parent + "/" + name)`。
   若用它做轮转并传完整备份路径，会得到错误嵌套路径、轮转静默失效。
   → 改用手写 `safeMoveFile`（见 CRITICAL-2），彻底不依赖这两个有陷阱的 API。
2. **模块加载期拼接路径会产生坏路径。**
   原写法 `export const runtimeLogPath = temporaryDirectoryPath + '/runtime.log'` 在加载期求值；平台目录极早未就绪时会得到字符串 `"undefined/runtime.log"` 而**不抛异常**，外层 `try/catch` 形同虚设。
   → 改为**惰性解析** + 类型校验，不可用时返回 `''`，调用方见空串即跳过所有文件操作、只留内存缓冲。

**lead 已独立复核确认上述修复方向正确**（字节数按真实 size 校准、`safeMoveFile` 才 unlink 源、`fs.stat` 为权威来源）。
**verifier 已独立复验全部 6 项通过**（逐行读最新代码，非采信报告），并确认修复"读代码验证"口径下**安全性/正确性通过**。

### 编码口径核实结论（lead 提出，已共同排除疑虑）

`readFile` / `writeFile` / `appendFile` 在**不传 encoding 时默认值一致，均为 `'utf8'`**：

- `node_modules/react-native-file-system/src/index.ts`：`readFile(path, encoding: Encoding = 'utf8')`、`writeFile(path, data, encoding: Encoding = 'utf8')`、`appendFile(path, data, encoding: Encoding = 'utf8')`
- `lib/commonjs/index.js:78/98/106` 同样默认 `'utf8'`
- 原生 `FileSystem.java:43` 读用 `StandardCharsets.UTF_8`；`:52`/`:62` 写用 `data.getBytes()`（JVM 默认 UTF-8）
- `stat` 的 size 为真实磁盘字节数（原生 `Utils.java:53`/`:71` `putDouble("size", file.length())`）

→ 因此 `safeMoveFile` 中 `fromSize`（stat 字节）与 `toSize`（stat 字节）**口径一致，比较有效**；不存在"编码不一致导致校验系统性失败"的问题。**该疑虑已被排除（lead 已撤回）。** 代码中**未**把 stat 字节数与 JS `String.length` 混比。

## 五、导出 API 清单（已冻结，T3/T4/T5 依赖）

> 约定：**可变参数中，最后一个参数若是"纯对象"则作为结构化字段**（输出 `k=v`）；其余参数以空格拼接，`Error` 取 `stack`。
> 「async」列 = 返回 Promise，建议 `await`。

### `src/utils/runtimeLog.ts`

**等级日志**（第一个参数固定为 `tag`）

| 导出 | 签名 | async | 语义 |
|---|---|---|---|
| `debug` | `(tag: string, ...args: any[]) => void` | 否 | 调试级，低于当前 `minLevel` 时丢弃 |
| `info` | `(tag: string, ...args: any[]) => void` | 否 | 常规信息 |
| `warn` | `(tag: string, ...args: any[]) => void` | 否 | 警告 |
| `error` | `(tag: string, ...args: any[]) => void` | 否 | 错误（STALL 判定亦用此级，保证不被 `setLevel` 过滤） |

**生命周期与落盘**

| 导出 | 签名 | async | 语义 |
|---|---|---|---|
| `init` | `(options?: RuntimeLogOptions) => Promise<void>` | **是** | 初始化日志文件。**幂等**；init 前的日志自动回灌；内部异常兜底 |
| `flush` | `() => Promise<void>` | **是** | **await 即确认已真正落盘**。AppState 变化、播放状态切换时调用 |
| `flushSyncBestEffort` | `() => Promise<void>` | **是**（返回 Promise） | **不保证一定落盘**。可 await 确认；同步收尾路径若不 await 则可能随进程丢失 |

**配置与读取**

| 导出 | 签名 | async | 语义 |
|---|---|---|---|
| `setLevel` | `(level: RuntimeLogLevel) => void` | 否 | 设置最低输出等级 |
| `getLevel` | `() => RuntimeLogLevel` | 否 | 读取当前最低等级 |
| `setOptions` | `(options: RuntimeLogOptions) => void` | 否 | 动态调整配置 |
| `getOptions` | `() => Required<RuntimeLogOptions>` | 否 | 读取配置副本 |
| `getEntries` | `() => RuntimeLogEntry[]` | 否 | 内存环形缓冲（结构化副本），失败返回 `[]` |
| `getSnapshot` | `(limit?: number, level?: RuntimeLogLevel) => string` | 否 | 内存最近日志文本，**"应用空白"直接展示**；失败返回 `''` |
| `exportDiagnostics` | `() => string` | 否 | 一次性导出：路径/等级/缓冲状态/写失败次数 + 最近日志 |
| `readLogFile` | `() => Promise<string>` | **是** | 读 `runtime.log` + `.1/.2` 备份（最旧在前），先 flush |
| `clear` | `() => void` | 否 | 清内存缓冲与待写队列（不动文件） |
| `clearLogFiles` | `() => Promise<void>` | **是** | 删除 `runtime.log` 及全部备份 |
| `runtimeLogPath` | `() => string` | 否 | 惰性解析路径；不可用返回 `''` |
| `legacyLogPath` | `() => string` | 否 | 旧 `error.log` 路径；不可用返回 `''` |

**内存采样**

| 导出 | 签名 | async | 语义 |
|---|---|---|---|
| `recordMemory` | `(tag?: string, extra?: Record<string, any>) => void` | 否 | 记录一次 JS 堆水位；无 `performance.memory` 时降级 no-op + 仅 warn 一次 |
| `startMemorySampling` | `(interval = 30000) => (() => void)` | 否 | 周期采样；**必须保存并使用返回的停止函数** |
| `isMemorySamplingSupported` | `() => boolean` | 否 | 当前环境是否支持内存采样 |

**旧通道桥接**（供 `log.ts` 使用，他人一般不需要）

| 导出 | 签名 | async |
|---|---|---|
| `writeLegacy` | `(level: 'LOG'\|'WARN'\|'ERROR', msg: string) => void` | 否 |
| `readLegacyLogFile` | `() => Promise<string>` | **是** |
| `clearLegacyLogFile` | `() => Promise<void>` | **是** |
| `rotateLegacyFileIfNeeded` | `() => Promise<void>` | **是** |

**类型**：`RuntimeLogLevel`、`RuntimeLogEntry`、`RuntimeLogOptions`。
**默认值**：`maxMemoryEntries: 1000`、`maxFileSize: 512*1024`、`maxBackupCount: 2`、`flushBatchSize: 20`、`flushInterval: 2000`、`minLevel: 'debug'`。
另有同名 `runtimeLog` 聚合对象与 `export default`。

### `src/utils/stallWatchdog.ts`

| 导出 | 签名 | async | 语义 |
|---|---|---|---|
| `start` | `(opts?: StallWatchdogOptions) => void` | 否 | 启动看门狗（默认 5s 心跳 / 20s 阈值）；重复调用仅更新配置并 warn |
| `stop` | `() => void` | 否 | 停止 |
| `isStarted` | `() => boolean` | 否 | 是否运行中 |
| `tick` | `() => void` | 否 | 手动打点一次 |
| `markEvent` | `(name: string, detail?: any) => void` | 否 | **记录关键事件**（保留最近 20 条）；STALL 时连同"最后一步"写日志。`detail` 会被裁剪：只留标量、字符串截断 200 字符、对象浅拷贝限 20 项/层 —— **请勿传整个对象** |
| `getRecentEvents` | `() => WatchdogEvent[]` | 否 | 最近关键事件 |
| `getLastStall` | `() => StallRecord \| null` | 否 | 最后一次卡顿记录 |
| `getStallCount` | `() => number` | 否 | 累计卡顿次数 |
| `setOnStall` | `(handler: ((record: StallRecord) => void) \| null) => void` | 否 | 注册/取消卡顿回调 |
| `getWatchdogSnapshot` | `() => string` | 否 | 看门狗状态文本 |

**类型**：`StallWatchdogOptions`、`WatchdogEvent`、`StallRecord`。另有 `stallWatchdog` 聚合对象与 `export default`。

### `src/utils/log.ts`（改造，**向后兼容**）

| 导出 | 签名 | async | 变化 |
|---|---|---|---|
| `init` | `() => Promise<void>` | **是** | 签名不变；内部转接 runtimeLog init + 旧文件轮转 |
| `getLogs` | `() => Promise<string>` | **是** | 签名不变；仍读 `error.log`（保留 `----lx log----` 分隔符）；为空时回退返回运行时快照 |
| `clearLogs` | `() => Promise<void>` | **是** | 签名不变；清空 error.log + 内存缓冲 |
| `log.info/warn/error` | `(...msgs: any[]) => void` | 否 | **签名完全不变**；行为与旧实现一致（`%c` 忽略、Error 取 stack） |
| `getLogPath` | `() => string` | 否 | 新增 |
| `getDiagnostics` | `() => string` | 否 | 新增（透传） |
| `getLogSnapshot` | `(limit?: number) => string` | 否 | 新增（透传） |
| `flushLogs` | `() => Promise<void>` | **是** | 新增（透传） |
| `flushLogsSyncBestEffort` | `() => Promise<void>` | **是** | 新增（透传，语义见上） |
| `setLogLevel` | `(level: RuntimeLogLevel) => void` | 否 | 新增（透传） |
| `getLogLevel` | `() => RuntimeLogLevel` | 否 | 新增（透传） |

## 六、兼容性核对（已静态确认）

现有 `log` 调用方全部位于以下文件，均只使用 `log.info/warn/error(...任意参数)`，签名未变：
`src/utils/errorHandle.ts`、`src/utils/localMediaMetadata.ts`、`src/core/userApi.ts`、`src/plugins/sync/log.ts`、`src/plugins/storage.ts`、`src/plugins/sync/client/*`、`src/screens/**/listAction.ts`、`src/components/**`、`src/core/init/userApi/index.ts`。

- `src/plugins/sync/client/modules/musicFile/logger.ts` 调用的是 `../../../log`（即 `src/plugins/sync/log.ts`）的 `r_warn`/`r_error`，后者转接 `@/utils/log` 的 `warn`/`error` —— **仍存在，无破坏**。
- `src/app.ts` 的 `import { init as initLog } from '@/utils/log'` —— **`init` 仍导出**。
- `src/screens/Home/Views/Setting/settings/Other/Log.tsx` 的 `getLogs`/`clearLogs` 及其 `----lx log----` 切分逻辑 —— **格式与语义保持**。

## 四、实现过程中发现并规避的两个真实缺陷

1. **`FileSystem.rename` 的第二参数不是目标路径，而是"同目录新文件名"。**
   原生实现 `FsFile.java: rename(name) => file.renameTo(new File(file.getParent() + "/" + name))`。
   若用 `rename(path, FULL_BACKUP_PATH)` 做轮转，会得到 `/…/runtime.log.1/runtime.log.2` 这类错误嵌套路径，轮转静默失效。
   → 已改用 `fs.ts` 的 `moveFile()`（即 `FileSystem.mv`，接受完整目标路径，`FsFile.java: mv(toPath)`）。
   这个问题**不会在 tsc/eslint 中暴露**（两边签名都是 `(string, string)`），只能靠读原生实现发现。

2. **模块加载期拼接路径会产生坏路径。**
   原始写法 `export const runtimeLogPath = temporaryDirectoryPath + '/runtime.log'` 在加载期求值；若平台目录极早尚未就绪，会得到字符串 `"undefined/runtime.log"` 而**不抛异常**，外层 `try/catch` 形同虚设。
   → 已改为**惰性解析**并校验类型（`typeof dir == 'string' && dir`），不可用时返回 `''`，调用方见到空串即跳过所有文件操作、只保留内存缓冲。

## 五、设计取舍说明

- **`getLogs()` 保留读 `error.log` 而非改读 `runtime.log`**：设置页按 `----lx log----` 切分，改读会让现有 UI 直接失效。因此旧通道继续写 `error.log`（并新增轮转），运行时结构化日志写 `runtime.log`；`getLogs()` 在旧文件为空时回退到内存快照，兼顾"不破坏 UI"与"日志不再为空"。
- **两套队列（`pending` / `legacyPending`）**：两种格式不同（结构化单行 vs `----lx log----` 分隔），分队列避免格式互相污染，`doFlush` 内合并处理、统一失败回退。
- **写失败放回队列但设上限**：避免 IO 长期失败时队列无限增长（同样按 `maxMemoryEntries` 截断）。
- **STALL 用 `error` 等级**：保证即使把 `minLevel` 调高，卡死证据也不会被过滤掉。

## 六、遗留与后续

1. **tsc/eslint 必须由有 shell 的会话复核**（见开头）；未取得既有错误基线。
2. 本模块只提供 API，**实际启动接入（`init` / `startWatchdog` / AppState flush）由 T4 负责**，播放链路埋点由 T3、设置页展示由 T5 负责；三者均已收到冻结后的 API 清单。
3. `recordMemory` 在正式版 RN 中通常因无 `performance.memory` 而为 no-op（仅 warn 一次）。若要真正拿到 Android 内存水位，需要新增原生桥（本任务明确要求不改原生代码，故按降级处理）。
4. 建议后续加一条**运行时自检**：启动时检查 `getPaths()` 是否为空串（平台目录不可用），届时日志只留内存、不落盘 —— 目前该情况是静默降级，排查时可能让人误以为"没有日志"。
