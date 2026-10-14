# T2 日志核心模块安全性审查（verifier 独立复核）

审查对象（已落盘，逐行读完）：
- `src/utils/runtimeLog.ts`（**初版 704 行 → 修订后 826 行**）
- `src/utils/stallWatchdog.ts`（**初版 247 行 → 修订后见文件**）

> 说明：本审查是 task-6 第 4 条"日志自身安全性审查"的**先行部分**。
> 它在 T3 完成前即可执行（不依赖埋点接入），因此提前做并把严重问题先反馈给 Lead。
> 本文件为**中间产物**；最终结论会并入 `verification.md`。

---

## ✅ 修订后复验结论（verifier 独立读代码确认，非采信报告）

logcore 已修订。我对**当前最新内容**逐行复核，**6 项发现全部确认修复**：

| 编号 | 严重度 | 原问题 | 复验结果 | 当前证据 |
|---|---|---|---|---|
| CRITICAL-1 | 🔴 | `text.length` 当字节数 | ✅ **已修** | 新增 `utf8ByteLength()`（`:322-344`），按码点统计含代理对；`:359`/`:381` 使用；`:363`/`:383` 比较 |
| CRITICAL-1b | 🔴 | legacy 轮转比"单批长度" | ✅ **已修** | `:382` `const size = await readSize(legacy)`，`:383` 用 `size + addBytes`（文件总大小） |
| CRITICAL-2 | 🔴 | `mv` 静默删源 | ✅ **已修** | 新增 `safeMoveFile()`（`:245-262`）：`readFile`→`writeFile`→`readSize` 校验大小→一致才允许删源；`:283`/`:289` 改为 `if (await safeMoveFile(...)) await unlink(from)` |
| MEDIUM-1 | 🟠 | `flushSyncBestEffort` 不保证落盘 | ✅ **已修** | `:513` 现返回 `Promise<void>` 且 `await doFlush()`；`:502-511` JSDoc 明确"**不保证一定落盘**""best effort 的固有限制" |
| MEDIUM-2 | 🟠 | `getSnapshot` 无保护 | ✅ **已修** | `:563-565` 改用 `safeRun` + `result` 兜底返回 `''`；`getEntries` `:549-555` 同样加固 |
| LOW-1 | 🟡 | `markEvent` 存 detail 引用 | ✅ **已修** | 新增 `sanitizeDetail()`（`:101-` 起）：字符串超长截断（`:107`）、数组截 20 项（`:116`）、递归深度限制；`:147` 应用 |
| LOW-2 | 🟡 | `startMemorySampling` 停止函数无人调用 | ⚠️ 见下 | 属 T4 接入责任，非 T2 缺陷 |

### 对 CRITICAL-2 修复的**独立评价**（重要）
logcore 没有采用我建议的"mv 后校验"，而是**更彻底地放弃了 `FileSystem.mv`**，
改为 `readFile` + `writeFile` + 大小校验 + 条件删源，并在 `:232-244` 的注释里
**准确复述了我提供的原生铁证**（`FsFile.java:143-156` 返回值被丢弃 + 无条件 delete）。
这个修法**优于我的建议**：`mv` 一旦失败就已删源，事后校验无法挽回；而 copy-then-verify-then-unlink
在失败时**保留源文件**（`:258` 注释明确"宁可不轮转，也不能丢日志"）。
**判断正确，实现正确。**

### 一处遗留观察（非缺陷，供 T4 注意）
`safeMoveFile` 用 `readFile` 把整个文件读进内存再 `writeFile`。
在 `maxFileSize` 为 512KB 量级时完全可接受；但若有人把 `maxFileSize` 调到数十 MB，
轮转将产生一次**大内存分配**。当前默认值下无风险，仅作提示。

---

## 初版审查记录（保留，供追溯）

以下为**修订前**（704 行版本）的原始发现。保留原因是：它记录了问题、修复过程与验证链条，
且 Lead 明确要求 baseline/基线类材料作为附录保留。

## 结论速览（修订前）

| 编号 | 严重度 | 问题 | 位置 |
|---|---|---|---|
| CRITICAL-1 | 🔴 高 | 轮转阈值用**字符数**当**字节数**，512KB 实际可长到 ~1.5MB，轮转承诺不成立 | `runtimeLog.ts:283` |
| CRITICAL-2 | 🔴 高 | `FileSystem.mv` 的 Java 层**不检查 `renameTo` 返回值却无条件 `delete()` 源文件** → 轮转可能静默删除日志 | `FsFile.java:145,156` + `runtimeLog.ts:248,251` |
| MEDIUM-1 | 🟠 中 | `flushSyncBestEffort` 只发起 Promise 不等待 → **崩溃前落盘无保证**，恰在最需要日志时丢失 | `runtimeLog.ts:409-414` |
| MEDIUM-2 | 🟠 中 | `getSnapshot` 是唯一**没有 `safeRun` 保护**的导出，且被 T4"启动超时"、T5"空白页"调用 | `runtimeLog.ts:454-462` |
| LOW-1 | 🟡 低 | `markEvent` 原样存 `detail` 引用，20 个引用可能长期阻止 GC | `stallWatchdog.ts:101-115` |
| LOW-2 | 🟡 低 | `startMemorySampling` 返回的停止函数若无人调用则计时器永久运行 | `runtimeLog.ts:589-605` |

**核心问题的正面结论**：`safeRun` / `safeRunAsync`（`runtimeLog.ts:69-89`）双层 try/catch，
内层 console 再包一层 try —— **日志模块自身抛错导致 App 崩溃的风险已被有效控制**。
task-6 第 4 条问"flush 是否可能抛异常导致 App 崩"→ **答案是不会崩，异常被吞**。

---

## CRITICAL-1：字节数 vs 字符数

`runtimeLog.ts:281-299`
```ts
const byteLength = text.length            // L283 ← 字符数（UTF-16 code unit 计数）
try {
  const size = state.currentSize || (await readSize(runtime))
  state.currentSize = size
  if (size + byteLength > state.options.maxFileSize) {   // L287
    ...
  } else {
    await appendFile(runtime, text)       // L296
    state.currentSize = size + byteLength // L299 ← 也是字符数
  }
```

### 论证
1. JS 的 `String.prototype.length` 返回 **UTF-16 码元个数**，与文件的 **UTF-8 字节数**在非 ASCII 内容下不相等。
2. 本工程的日志内容是**中文为主**：tag 前缀是 ASCII（`[PLAYER]` 等），但 message/字段值大量含中文
   （如"获取链接失败""已暂停"）。UTF-8 下中文 **3 字节/字符**，ASCII **1 字节/字符**。
3. 故 `text.length` **系统性低估**实际写入字节数，中文占比越高低估越严重，**最坏约 3 倍**。
4. `readSize`（`runtimeLog.ts:263-270`）走的是 `stat`，返回的**是真实字节数**——
   即 L283 的估算口径与 L283 之外的 `readSize`（用于 `currentSize` 初值，L382）**口径不一致**。
5. 结果：`maxFileSize = 512*1024` 的默认值，在中文日志下可能到 **~1.5MB** 才触发轮转。
   考虑到 `maxBackupCount = 2`，磁盘占用上限从声称的 ~1.5MB 变为 **~4.5MB**。
6. 这**没有**造成无限增长（轮转终究会触发），所以不推翻"防止无限增长"的目标；
   但 T2 验收里"单文件超过阈值（默认 512KB）就切分"这一条**在实现上不成立**。

### 修复建议
```ts
const byteLength = Buffer.byteLength(text, 'utf8')   // 或 text.length 的保守放大
```
若不想引入 `Buffer`（RN 中 `@craftzdog/react-native-buffer` 已在依赖里，`package.json:47`），
可用保守估算：`text.length * 3`。

### 我无法自行验证的部分（诚实标注）
我**不能运行 node 脚本**去实测文件大小（pwsh 全挂，见 `baseline-tooling-probe.txt`）。
上述是**代码口径分析**，`String.length` 的语义是确定的语言事实，不属猜测。
请 logcore 用 `Buffer.byteLength` 复核。

---

## CRITICAL-2：`mv` 在 Java 层静默吞掉失败并删除源文件

### 调用链
`runtimeLog.ts:248` / `runtimeLog.ts:251`
```ts
await moveFile(from, to).catch(() => {})
await moveFile(path, backupPathOf(path, 1)).catch(() => {})
```
→ `fs.ts:54` `export const moveFile = async(fromPath, toPath) => FileSystem.mv(fromPath, toPath)`

### 底层实现（已读源码确认）
`node_modules/react-native-file-system/android/src/main/java/com/filesystem/FsFile.java:142-157`
```java
} else {
  if (uri == null) {
    File desFile = new FsFile(this.context, toPath).file;
    this.file.renameTo(desFile);     // L145 ⚠️ 返回值被丢弃！
  } else {
    // 流拷贝分支
  }
  this.file.delete();                // L156 ⚠️ 无条件删除源文件
}
```

### 论证
1. `java.io.File.renameTo` 的契约是：**成功返回 true，失败返回 false，失败原因不抛异常**。
   目标已存在、跨文件系统、权限不足时都可能返回 `false`。
2. 该 Java 方法**不检查返回值**，随后 **无条件执行 `this.file.delete()`**（L156）。
3. → 若 `renameTo` 失败，源文件被删除、目标文件不存在或为旧内容 = **数据静默丢失**。
4. JS 侧 `FileSystem.mv` 正常 resolve（Java 未抛异常），`.catch(() => {})` 也不会触发 →
   **JS 完全感知不到日志被删**。
5. 对"排查 App 崩溃/白屏"这一原始目标而言，**证据被销毁比不写日志更糟**：
   用户以为拿到了日志，实际关键段落已消失，且无人知道。

### 为什么当前多数情况下侥幸不翻车
`rotateFile`（`runtimeLog.ts:234-253`）在每次 mv 前都先 `unlink(to)`
（L241 删最旧备份；L247 删 `to`），所以**目标通常不存在**，`renameTo` 大概率成功。
但这依赖"unlink 必须成功"——而 L247 的 `.catch(() => {})` 同样吞掉了 unlink 失败。
若 unlink 因文件被占用/权限失败，紧接着的 mv 就会命中"目标已存在"而失败并删源。

### 修复建议
1. 用 **copy + 校验 + 再删源** 替代 mv（`fs.ts` 已有 `copyFile` L52 / `unlink` L36）。
2. 或在 `fs.ts` 增加一个 `moveFileChecked`，在 mv 后用 `existsFile(to)` 校验，失败则告警。
3. 至少在 `rotateFile` 内对 mv 后用 `existsFile(to)` 复核并在失败时写入一条 warn 日志
   （注意避免递归）。

---

## MEDIUM-1：`flushSyncBestEffort` 无法保证崩溃前落盘

`runtimeLog.ts:405-414`
```ts
/**
 * 同步尽力落盘。用于 App 即将挂起/崩溃等无法等待 Promise 的场景，
 * 触发一次异步 flush 并立即返回（不阻塞 JS 线程）。
 */
export const flushSyncBestEffort = (): void => {
  safeRun(() => {
    clearFlushTimer()
    void doFlush()          // L412 ← 只发起，不等待
  })
}
```

### 论证
1. `doFlush` 内部是 `await appendFile(...)`（L289 / L296）——**跨 RN 桥的异步原生调用**，
   不可能在 JS 同步栈内完成。
2. 因此 `flushSyncBestEffort()` 返回时，数据**仍在 pending 队列或已在途**，**尚未落盘**。
3. 调用方两处都指望它救命：
   - `stallWatchdog.ts:158`（STALL 恢复后立即落盘，注释明确写"避免恢复瞬间再次卡死导致这条关键日志丢失"）
   - T3 要在 `src/utils/errorHandle.ts` 的异常处理里调用（"确保崩溃前落盘"）
4. 但**崩溃/进程被杀**时事件循环停止，未完成的 Promise **永不 resolve** →
   **恰好在最需要日志的时刻丢失日志**，与本模块的设计目标（L11-12）直接矛盾。

### 现实约束与修复建议
RN 中**确实没有**真正的同步文件写（这是平台限制，不是 logcore 的疏忽）。
但可以显著改善：
1. 让 `flushSyncBestEffort` **返回 `doFlush()` 的 Promise**（`Promise<void>`），
   调用方可 `await` / 在 `unhandledRejection` 前争取时间；`errorHandle` 的 handler 是同步的，
   但 `stallWatchdog` L158 处是同步上下文，改为 `void flush().finally(...)` 亦可。
2. 更关键：**降低 flush 延迟与批量阈值**，让"未落盘窗口"尽可能小。
   当前 `flushInterval=2000` / `flushBatchSize=20`（`runtimeLog.ts:50-51`），
   即最坏有 2 秒 / 20 条的日志悬在内存中。
3. 在文档与代码注释里**明确"best effort ≠ 保证"**，避免调用方误以为已落盘。

---

## MEDIUM-2：`getSnapshot` 缺少异常保护

`runtimeLog.ts:454-462`
```ts
export const getSnapshot = (limit?: number, level?: RuntimeLogLevel): string => {
  let list = state.entries
  if (level != null) { ... list = list.filter(...) }
  if (limit != null && limit > 0 && list.length > limit) list = list.slice(-limit)
  return list.map(entry => entry.text).join('\n')   // L461
}
```
- 本模块几乎所有导出都用 `safeRun`/`safeRunAsync` 包裹
  （`write` L361、`setLevel` L423、`setOptions` L433、`clear` L487、`recordMemory` L560、
  `startMemorySampling` L591、`writeLegacy` L613 …），**唯独 `getSnapshot`（及 `getEntries` L445）没有**。
- 而 `getSnapshot` 恰恰被用在**App 已经不正常**的路径上：
  T4 要求的"启动超时兜底日志"要包含它；T5 的"空白页"展示要包含它。
- 违反模块自己声明的原则（L12「日志本身任何失败都必须静默降级」）。

**建议**：`safeRun` 包裹并失败时返回 `''`。

---

## LOW-1：`markEvent` 的 detail 引用可能阻碍 GC

`stallWatchdog.ts:101-115`
```ts
export const markEvent = (name: string, detail?: any): void => {
  safeRun(() => {
    ...
    const event: WatchdogEvent = { name, detail, time, timeText }  // L104-109 ← detail 原样存引用
    recentEvents.push(event)
    if (recentEvents.length > maxRecentEvents) {                    // L111-112 上限 20，OK
      recentEvents.splice(0, recentEvents.length - maxRecentEvents)
    }
  })
}
```
- 条数上限（20）正确，**不构成无界增长**。
- 但 `detail` 是**对象引用**。T3 被要求"在每个关键步骤前后调用 `markEvent`"，
  若某处图省事传入 `musicInfo`（含歌词全文、封面 URL/base64）或整个 `playerState`，
  则**最多 20 个这样的对象会一直被 `recentEvents` 持有**，无法回收。
- 在"长时间听歌 + 内存压力"**正是本次事故根因**的场景下，看门狗自己成为泄漏源，是讽刺且真实的复合风险。
- **建议**：`markEvent` 内对 `detail` 做浅拷贝，或限制为标量/短字符串（截断到 N 字符）。

## LOW-2：`startMemorySampling` 的计时器
`runtimeLog.ts:589-605` 返回停止函数，但**工程内暂无任何调用点**（T4 尚未接入）。
若 T4 只调用 `startMemorySampling()` 而不保存返回的停止函数，`setInterval` 将永久运行。
属提醒级（本身不泄漏大内存，只是持续产生日志）。

---

## 正面清单（避免只报负面，供 Lead 判断质量）

| 项 | 位置 | 评价 |
|---|---|---|
| 日志自身异常隔离 | `runtimeLog.ts:69-89` | ✅ 双层 try/catch，内层 console 再包 try，很扎实 |
| 内存环形缓冲上限 | `runtimeLog.ts:332-335` | ✅ splice 到 maxMemoryEntries |
| pending 队列上限 | `runtimeLog.ts:305-307` | ✅ 写失败回灌时防止队列爆掉 |
| recentEvents 上限 | `stallWatchdog.ts:111-112` | ✅ 20 条 |
| 防并发 flush | `runtimeLog.ts:276` | ✅ `isFlushing \|\| isRotating` 重入保护 |
| flush 期间不丢新日志 | `runtimeLog.ts:279-280` | ✅ 先整体取走 pending 再清空 |
| 路径惰性解析 + 空串降级 | `runtimeLog.ts:189-201` | ✅ 避免 `undefined/runtime.log` |
| scheduleFlush unref | `runtimeLog.ts:222` | ✅ 不拖住进程退出 |
| STALL 用 error 级 | `stallWatchdog.ts:148` | ✅ 保证不被 setLevel 过滤掉 |
| setInterval 探阻塞 | `stallWatchdog.ts:183` | ✅ 思路正确（回调延迟即阻塞证据） |
| 各 fs 调用均带 .catch | `runtimeLog.ts:237-260` | ✅ 单点失败不中断流程 |
| 不引入新依赖 | 全文件 | ✅ 仅用 fs.ts 封装 |

---

## 与 task-6 验收条款的对应

- 第 4 条「flush 是否可能抛异常导致 App 崩」→ **否**（CRITICAL 无此项风险），见上表第 1 行。
- 第 4 条「热路径是否同步 IO 阻塞」→ **热路径无同步 IO**：`write()` 只做内存 push
  （`runtimeLog.ts:332-338`），IO 全部在 `doFlush` 的异步分支。
  但 `formatTimeText` 与字符串拼接在每次调用时执行（L322-330），高频埋点下是**纯 CPU 开销**，
  不阻塞但会增加 GC 压力 —— 属可接受，建议 T3 在高频回调（PlaybackState/playProgress）节制埋点。
- 第 4 条「轮转是否真能限制文件大小」→ **不能严格限制**，见 CRITICAL-1（口径错误）+ CRITICAL-2（可能静默丢数据）。
