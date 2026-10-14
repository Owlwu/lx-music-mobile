# T6 独立验证报告（verifier）

> ## ⚠️ 顶部声明（必读，**已更新至最终状态**）
>
> ### 门禁状态：`npm run tsc` = 0、`npm run lint` = 0
> **由 Lead 实测；verifier 未亲测。** 原因见下 —— verifier 的 shell 全程不可用，
> **且作为 subagent 其权限在会话启动时即被固定，无法从内部放宽**
> （用户把 Lead 会话切到 full-access **不会**追溯解禁 verifier 的会话）。
> 命令原文与 `git diff` 输出由 **Lead 代跑**，verifier 据此做**加性逻辑复核**（§10）。
>
> ### verifier 自身未能执行的命令
> **`tsc` / `eslint` / `git` 在 verifier 会话中始终无法执行。**
> `sandbox-local windows-acl temp grant materialization failed and its cleanup also failed`
> （含最小探测 `pwd` 同样失败，排除命令本身问题）。
> 官方修复脚本已试两次（一次由 Lead、一次由 verifier），**均被拒绝或不适用**；
> 按技能硬规则停止（不重试、不绕过、不改 `-AllowRoot`）。
> 技术根因：断点在祖先目录 `E:\WorkSpace` 与 `E:\`（owner 为另一 SID，
> `WRITE_DAC=False / WRITE_OWNER=False`），当前用户无权修改。
>
> ### 因此本报告的证据分级
> | 证据类型 | 来源 | 可信度 |
> |---|---|---|
> | 门禁结果（tsc/lint = 0） | **Lead 代跑** | ⚠️ 采信但**未复现** |
> | `git diff b2b3dab 75ba8d04` | **Lead 代跑** | ⚠️ 采信但**未复现** |
> | **逻辑回归 / 控制流等价性 / 类型核实** | **verifier 独立读码** | ✅ **独立验证**（本报告的核心价值） |
>
> **本报告的核心结论（T3 零业务分支改动、`unref` 守卫保留、4 处 `??` 等价、
> `player.d.ts` 放宽不削弱保护）均为 verifier 独立读码得出，不依赖上述代跑证据。**
>
> 原始失败证据见 `baseline-tooling-probe.txt`；基线原文见 `baseline-git.txt`。

> ### 📌 当前有效终态
> **`75ba8d04`**（`src/**` 的"冻结"在本会话被打破过两次：① `app.ts` 内存采样 → §9；
> ② tsc/lint 门禁引入后的 `b2b3dab`+`75ba8d04` → **§10**）。
> **§10 是最新一轮增量复审，其结论优先。**

---

## 0. 结论摘要

| 项 | 结论 |
|---|---|
| **总体判定** | ✅ **通过（逻辑复审口径）**，对应终态 **`75ba8d04`**。未发现会导致 App 崩溃或改变播放行为的**遗留**缺陷。**2 处真实缺陷均由 verifier 独立发现，均已修复并复核终态**；`tsc`/`lint` 门禁已双绿（Lead 实测） |
| **门禁** | ✅ `npm run tsc` = 0、`npm run lint` = 0 —— **Lead 实测，verifier 未亲测**（§10.0） |
| T3 逻辑回归 | ✅ **通过**。1 处真实回归**由 verifier 独立发现**，已修复；`caaed5a→75ba8d04` 的 lint/type 改动经 §10 加性复核**未夹带业务改动** |
| T2 日志模块安全性 | ✅ **通过**。6 项发现（含 3 项 CRITICAL）全部由 logcore 修复，verifier 独立读码确认；**`unref` 运行时守卫保留** ✅（§10.2） |
| 埋点覆盖度 | ⚠️ **18/25 条已落地，7 条未落地**（详见第 4 节 + 第 9.5 节更新，均**不阻塞**本次目标） |
| T5 UI/i18n | ✅ **通过**。1 处**用户可见缺陷**（清空按钮错位）**由 verifier 发现**，已修复复核；i18n 三语齐全 |
| Lead 原生结论 F1 | ❌ **已由 verifier 独立推翻**（见第 6 节） |
| 未验证项 | ⚠️ 见第 7 节；**新增**：`PLAY_LATER`（`listId === null`）路径需真机验证（§10.5） |

### 严重问题清单（按严重程度排序）

| # | 严重度 | 问题 | 位置 | 状态 |
|---|---|---|---|---|
| 1 | 🔴 高 | `initial()` 的 `updateOptions`/`setVolume`/`setPlaybackRate` 被误加 `try/catch`，把**会冒泡中断的失败变为静默继续** → 播放器半初始化却被认为正常 | `src/plugins/player/index.ts:65-80`（初版） | ✅ **已修复**（verifier 发现） |
| 2 | 🟠 中 | 设置页"查看运行时日志"弹窗的"清空"按钮实际删的是 `error.log`，且不删用户正在看的 `runtime.log` → **两份证据同时丢失** | `Log.tsx:160-161` + `:53-58`（初版） | ✅ **已修复**（verifier 发现，方案优于 Lead 建议） |
| 3 | 🟠 中 | `handleShowRuntimeLog` 的 `.then` 链**无 `.catch`** → 失败时弹窗永不打开、按钮无反应 | `Log.tsx:64-72`（初版） | ✅ **已修复** |
| 4 | 🟡 低 | `runtimeLog.flushSyncBestEffort` **不保证**崩溃前落盘（RN 无真同步写，平台限制） | `runtimeLog.ts:513-518` | ⚠️ 已文档化，属平台限制 |
| 5 | 🟡 低 | `getOtherSource` 新增了一次**冗余缓存复查**（L59-62，L27 已返回，实际不可达） | `core/music/utils.ts:59-62` | ⚠️ 无害，建议清理 |
| 6 | 🟡 低 | `t4-report.md` 的锚点行号有**系统性偏差**（7 个锚点中 6 个 +1、超时块 −3；`void initLog()` 报 `:94` 实际 `:95`） | `.diagnosis/t4-report.md` | ✅ **已修正并复核闭环**（详见 9.8） |
| 7 | 🟢 提示 | verifier 的 shell 全程不可用且**无法从内部放宽**（subagent 权限启动时固定）→ 门禁/git 证据均为 **Lead 代跑** | —（环境限制） | ⚠️ 已如实标注（§10.0） |
| 8 | 🟡 低-中 | `player.d.ts` 的 `PlayMusicInfo.listId` 放宽为 `string \| null`：**无运行时变化**，但**扩大编译期检查面** → 若存在未做 null 判断的消费点，缺陷会推迟到运行时暴露 | `src/types/player.d.ts:38`（`b2b3dab`） | ⚠️ **需真机验证 `PLAY_LATER`（`listId === null`）路径**（§10.5） |

> **⚠️ 审查时点声明（重要）**：本报告主体完成于 task-6 complete 之时。
> 之后 boottrace 又对 `src/app.ts` 做了一轮"覆盖度补修"（**在我完成 task-6 之后**）。
> verifier 已对该改动做**增量复查**，结论见 **第 9 节**；第 9 节的结论**优先于**第 2/4 节中关于
> `app.ts` 的旧描述。

---

## 1. 验证方法与基线说明（替代 git diff）

### 1.1 为何不用 git
`git status` / `git diff` / `git stash` **全部无法执行**（见顶部豁免声明）。
task-6 原文要求"改用 `git diff --stat` 与逐文件分析"，但 `git` 本身也不可用。

### 1.2 verifier 的替代方案（这是本报告的核心方法论）
在 **T2 尚未落盘、T3 尚未触碰播放链路** 时（task-2 仍 `in_progress`，task-3~5 仍 `pending`），
verifier 用 `read` 工具**逐文件抓取了 T3 全部 11 个写入范围文件的改动前原文**，
并记录关键行号锚点，存为 `.diagnosis/baseline-git.txt`。

- **覆盖范围**：T3 的 11 个文件 **100% 覆盖**（`plugins/player/{index,utils,service}.ts`、
  `core/music/utils.ts`、`core/player/{player,utils}.ts`、
  `core/init/player/{playStatus,playProgress,preloadNextMusic,playerEvent}.ts`、
  `utils/errorHandle.ts`），另加 `utils/log.ts`、`utils/fs.ts`。
- **未覆盖**：T4 的 `app.ts` / `navigation/*` / `core/init/{index,dataInit}.ts` / `bootLog.ts`
  与 T5 的 `Log.tsx` / `lang/*.json` —— 这些在基线采集时**尚未改动**，但 verifier 未逐一固化原文，
  故这几处的审查为"读终态 + 逻辑合理性判断"，**强度低于 T3 的逐字对照**（诚实标注）。

### 1.3 基线可信度声明
`.diagnosis/baseline-git.txt` 中的行号与内容为 verifier 手工读取记录，**非 shell 计算**，
不作密码学证明，仅用于定位与对照。采集时刻为 T3 动手**之前**，故基线未受 T3 污染。

### 1.4 ⚠️ 终态冻结前提（**已两次失效，见 §10**）

> **本节原记录的是"`app.ts` 冻结"的第一次确认。该前提此后已被打破两次**
> （① `app.ts` 内存采样接入 → §9 已补做增量复查；② **`npm run tsc`/`lint` 门禁引入后的
> `b2b3dab` + `75ba8d04` 两次提交** → **§10 为本报告的最新一轮增量复审**）。
> **当前有效终态为 `75ba8d04`。** 本节与 §2/§9 的结论在经 §10 复核后仍然成立。

**第 2 节"逐字基线对照、零业务分支改动"的结论，只对 T3 的 11 个文件成立，
且仅在它们自我读取终态之后保持不动时有效。** 第一次确认由 Lead 提供：

- **Lead 实测确认**（非采信队友声明）：全队 6 名队友**全部 `inactive`**，
  无人持有 `src/**` 写入范围；Lead 未再派发任何 `src/**` 改动。
- **Lead 逐个复核了 verifier 点名的 4 个关键文件**（独立于 boottrace 的冻结声明）。
- **verifier 亦独立复测**（§9 定稿时）：
  - `plugins/player/index.ts`：`try {` **零命中**；`:71 await updateOptions()` /
    `:75 await setVolume()` / `:79 await setPlaybackRate()` ⇒ 高 severity 回归**已修复且未反复** ✅
  - `core/player/player.ts`：`.finally(` **仍在**（未被改成 `.catch`）；
    `await setStop()` **未加超时、未加 catch** ✅
  - `utils/errorHandle.ts`：`Alert.alert(` 与 `log.error(e.stack)` 均在 ⇒ **Alert 行为完整保留** ✅
  - `app.ts`：**224 行**，7 个锚点 `:45/:95/:113/:130/:147/:215/:220` 复测不变 ✅
- **第一次"验证后改动"**是 `app.ts` 的内存采样接入，已由 verifier **补做增量复查（§9，✅ 通过）**。

> ⚠️ **有效性边界（必须随报告一并传达）**：
> **若后续再修改 `src/`，本节及第 2 节的验证结论需整体重做。**
> verifier 无 shell / 无 git，**无法自行监测全仓写入**，只能依赖人工确认。
> **本会话 shell 至今不可用**（见 §10.0），故本轮仍需 Lead 代跑命令。

---

## 2. T3 逻辑回归审查（最高优先级）

**方法**：对 11 个文件逐一比对「基线原文」与「终态」，逐行确认每个 `catch`/`finally`/`return`/
switch 分支/判定条件的语义等价性。

### 2.1 ✅ 逐字等价（仅增量日志，零业务分支改动）

| 文件 | 复核要点 | 结论 |
|---|---|---|
| `plugins/player/service.ts` | `PlaybackError`：`console.log` → `error()` → `flush()` → `app_event.error()` → `playerError()`，**顺序与调用完全一致**（`:91-107`）✅<br>`PlaybackState`：双守卫 `if (gettingUrlId \|\| isTempId()) return` **仍在 switch 之前**（`:125-132`）✅；switch 7 分支体/顺序/`isPlayedStop` 检查全同（`:135-160`）✅<br>`PlaybackTrackChanged`：赋值 → `track == null` → `isPlayedStop` → `isEmpty()` **顺序一致**（`:165-209`）✅ | ✅ 等价 |
| `core/player/player.ts` | `getMusicPlayUrl` 的 toggle 回退 → then 守卫 → catch 三分支（忽略 / `delayRetry` / 重试一次 / throw）**逐分支等价**；`isRetryed` 重试次数未改（`:126-184`）✅<br>`setMusicUrl`：守卫 → `cancelDelayRetry` → 设 `gettingUrlId` → then/catch/**`.finally` 保留**（`:187-225`）✅<br>`handlePlay`：`await setStop()` **未加超时、未加 catch**（`:349`）✅<br>`playNext` 10 条 return 路径 + `playPrev` 全部出口：**逐条保留**，仅在各 return 前插日志（`:516-785`）✅ | ✅ 等价 |
| `core/music/utils.ts` | `getOnlineOtherSourceMusicUrl` 的 `while` + `continue` + `onToggleSource` + `break`、`tooManyRequests` 时 throw、递归换源**完全一致**（`:273-334`）✅<br>`getOtherSource` 的 `.catch(reject)` → `.catch(err => { log; reject(err) })`：**同一 reject、同一 err 对象**（`:85-87`）✅ | ✅ 等价（1 处冗余见 2.4） |
| `core/init/player/playerEvent.ts` | 25s 超时两分支判定一致（`:35-43`）✅；`handleError` 的 `retryNum < 2`、`setMusicUrl(refresh)`、`getPosition().then().**finally**`（`:135` **保留**）、`isActive()` 分支**完全一致**（`:119-163`）✅ | ✅ 等价 |
| `core/init/player/playProgress.ts` | `getCurrentTime` 追加 `.catch` 仅记日志（见 2.2）✅；`getMaxTime`/`startUpdateTimeout`/事件绑定未变 ✅ | ✅ 等价 |
| `core/player/utils.ts` | `filterList` 空列表回退 `clearPlayedList()` 逻辑一致，仅加日志（`:128-134`）✅ | ✅ 等价 |
| `utils/errorHandle.ts` | **`Alert.alert` 完整保留**（`:51-65`）、`toast` 排除分支（`:48-50`）、`log.error(e.stack)`（`:68`）**逐字未变**；新增 `flushFatalContext` 在 **`log.error` 之后**追加（`:70-75`），**不改变原有控制流** ✅ | ✅ 等价 |
| `plugins/player/utils.ts` | `setVolume`（`:195`）、`setPlaybackRate`（`:196`）、`setCurrentTime`（`:194`）**裸透传，毫未改动** ✅<br>`updateOptions`（`:293-339`）`return TrackPlayer.updateOptions(options).then(...)`，**无 try/catch** ✅<br>`setPlay`/`setPause`/`setStop`：**无 try/catch**，仅加 markEvent/log/耗时 ✅ | ✅ 等价 |
| `plugins/player/index.ts` | `migratePlayerCache`（`:48`）与 `setupPlayer`（`:52`）**原样透传** ✅；守卫命中加日志后 `return` ✅ | ✅ 等价（尾部曾回归，见 2.3） |

### 2.2 ✅ 3 处"追加 `.catch` 仅记日志"—— 属批准类（不可见 → 可见）

Lead 已批准这 3 处，verifier 独立复核**确认成功路径逐字未变**：

| 位置 | 改动 | 复核 |
|---|---|---|
| `core/init/player/preloadNextMusic.ts:34/63-69` | 无 try/catch → `try/catch/finally`，`finally` 释放 `isLoading` | ✅ 成功路径 `:35-61` 分支与取值与基线一致；**`finally` 只救 reject，救不了 hang**（见第 7 节残余风险） |
| `core/init/player/playProgress.ts:41-44` | `getPosition().then(...)` 后追加 `.catch` + `error()` | ✅ 原 `.then` 内容未动 |
| `core/init/player/playStatus.ts:28-34` | `void updateMetaData(...)` → `void updateMetaData(...).catch(...)` | ✅ 调用与参数**逐字未变** |

**判据（本报告确立的可复用准则）**：
> **只允许把"本来就不可见"的失败变为可见**（追加 `.catch`/`.finally` 记日志）；
> **绝不允许把"会中断的失败"变为静默继续**（给裸 `await` 加 `try/catch` 吞掉异常）。

依据：上述 3 处原本是 **unhandled rejection（本来就不可见）** → 记日志是信息量严格增加；
而第 2.3 节的 `initial()` 三处原本是 **冒泡中断** → 包装后方向相反，**不能套用同一理由**。

### 2.3 🔴 由 verifier 独立发现的真实回归（已修复）

**位置**：`src/plugins/player/index.ts:65-80`（初版）

**基线原文**（改动前，`baseline-git.txt` 已固化）：
```ts
await updateOptions()
await setVolume(volume)
await setPlaybackRate(playRate)
```

**当时的错误实现**：
```ts
try { await updateOptions() } catch (err) { error('PLAYER', 'updateOptions failed', ...) }
try { await setVolume(volume) } catch (err) { error('PLAYER', 'setVolume failed', ...) }
try { await setPlaybackRate(playRate) } catch (err) { error('PLAYER', 'setPlaybackRate failed', ...) }
```

**为何是真实的行为回归**（verifier 论证）：
1. `initial()` 的唯一调用点 `core/player/player.ts:312` 被 `handlePlay()` **await**。
2. **基线**：三步任一 reject → 异常**向上冒泡**出 `initial()` → 冒泡出 `handlePlay()`，
   播放器初始化失败**可见且中断**。
3. **错误实现**：异常被吞成一条日志，`initial()` **正常返回**；
   而 `global.lx.playerStatus.isInitialized` 早在 `:60` 已置 `true` →
   `handlePlay()` 误认为初始化成功并继续 → 播放器陷入**半初始化**
   （音量/倍速/通知选项未生效）却被认为一切正常。
4. 与 Lead 的裁决口径直接冲突（Lead 明确要求这三处"应已回滚为原样透传"）。
5. **代价与收益不成比例**：把"可见且中断"变成"静默继续"，方向与 2.2 的批准理由**相反**。

**终态（verifier 已复核）**：`src/plugins/player/index.ts:70-80`
```ts
info('PLAYER', 'updateOptions start', ...)
await updateOptions()                                   // L71 裸 await ✅
info('PLAYER', 'updateOptions done', ...)
info('PLAYER', 'setVolume start', ...)
await setVolume(volume)                                 // L75 裸 await ✅
info('PLAYER', 'setVolume done', ...)
info('PLAYER', 'setPlaybackRate start', ...)
await setPlaybackRate(playRate)                         // L79 裸 await ✅
info('PLAYER', 'setPlaybackRate done', ...)
```
并附 `:65-69` 注释说明为何必须保持裸 await。**异常恢复向上冒泡，与基线语义一致 ✅**
连带修正：回滚后 `:3` 的 `error` 成为未使用 import（会触发 eslint `no-unused-vars`），
已改为 `import { info, flush } from '@/utils/runtimeLog'` ✅

> **价值说明**：此回归由 **verifier 独立复核发现**，playerhook 的自查未能覆盖
> （其 `t3-report.md` 第 4.1 节已如实记录"由 verifier 独立复核发现"）。
> 这是本次独立验证最直接的产出。

### 2.4 ⚠️ 轻微问题：`getOtherSource` 冗余缓存复查

`core/music/utils.ts:59-62`
```ts
if (otherSourceCache.has(musicInfo)) {
  info('MUSIC_URL', 'getOtherSource hit result cache', { key })
  return otherSourceCache.get(musicInfo)!
}
```
基线 `:25` 已有同样的 `otherSourceCache.has(musicInfo)` 检查并返回（该行仍在，现为 `:27`）。
因此 L59-62 **实际不可达**（同一函数内、中间无 `set` 操作）。

- **影响**：无功能影响（不可达），仅多一段死代码与一个多余的日志分支。
- **判定**：**无害，不构成回归**。建议清理，但不阻塞交付。
- **诚实标注**：T3 报告第 4 节称此处为"仅调整了日志插入位置"，措辞略有偏差——
  实际是**新增**了一段不可达的复查，而非单纯挪位置。不影响行为，仅记录事实。

### 2.5 逻辑回归审查结论
**✅ 通过。** 除 2.3（已修复）与 2.4（无害冗余）外，
T3 的全部 11 个文件**未改变任何业务分支**：所有 `return`/`catch`/`finally`/switch 分支/
判定条件/调用顺序均与基线等价，仅新增日志与 `markEvent` 打点。
`src/plugins/player/playList.ts` **未被改动**（不在 T3 写入范围），
`playPromise.finally`（`:190`）原样保留，**无越界** ✅

---

## 3. T2 日志模块自身安全性审查（独立读码确认）

> 本节复核 Lead 转述的 4 项 + verifier 自己发现的 2 项，共 6 项。
> **verifier 逐一读了终态源码，未采信任何报告。**

| 编号 | 原问题（verifier 提出） | 终态证据（verifier 读码确认） | 结果 |
|---|---|---|---|
| CRITICAL-1 | `text.length` 当字节数（UTF-16 vs UTF-8），轮转阈值失真最坏 3 倍 | 新增 `utf8ByteLength()` `runtimeLog.ts:322-344`：按码点统计，正确处理代理对（`:330-338`）；`:359`/`:381` 使用；`:363`/`:383` 比较 | ✅ 已修 |
| CRITICAL-1b | legacy 轮转比的是"单批长度"而非文件大小 → `error.log` **永不轮转** | `:382` `const size = await readSize(legacy)`（**真实文件大小**），`:383` `size + addBytes`；注释 `:379` 写明原因 | ✅ 已修 |
| CRITICAL-2 | `FileSystem.mv` 的 Java 层丢弃 `renameTo` 返回值却无条件 `delete()` 源文件 → 日志被静默销毁 | 新增 `safeMoveFile()` `:245-262`：`readFile` → `writeFile` → `readSize` **校验大小一致** → 若不符**保留源文件**并记 warn；`:283`/`:288` 改为 `if (await safeMoveFile(...)) await unlink(from)` | ✅ 已修 |
| CRITICAL-3 | `rotateFile` 无条件 `writeFile(path, '')` → 搬运失败时"备份被删 + 主文件被清空 = 日志全没" | `:297-300` **仅当 `safeMoveFile` 成功才 `unlink` + `writeFile('')`**；失败保留原文件放弃本次轮转（`:301-303` 仅处理文件不存在的情况） | ✅ 已修 |
| MEDIUM-1 | `flushSyncBestEffort` 只发起 Promise 不等待 → 崩溃前落盘无保证 | `:513` 返回 `Promise<void>` 且 `await doFlush()`；`:502-511` JSDoc 明确"**不保证一定落盘**""best effort 的固有限制" | ✅ 已修 |
| MEDIUM-2 | `getSnapshot` 是唯一无 `safeRun` 保护的导出，却在最不正常时被调用 | `:563-565` `safeRun` + 返回 `''`；`getEntries` `:549-555` 一并加固 | ✅ 已修 |
| LOW-1 | `markEvent` 原样存 `detail` 引用 → 20 个引用可能长期阻 GC | 新增 `sanitizeDetail()` `stallWatchdog.ts:101-128`：字符串截断 200 字符（`:107`）、数组截 20 项（`:116`）、对象截 20 键（`:121`）、深度限制（`:113`）；`:147` 应用 | ✅ 已修 |

### 3.1 对 CRITICAL-2 修复方案的独立评价
logcore **未采纳** verifier 建议的"mv 后校验"，而是**彻底放弃 `FileSystem.mv`**，
改为 copy → 校验大小 → 才允许删源。**这优于 verifier 的建议**：
`mv` 一旦失败**源文件已被删除**，事后校验无从挽回；copy 方案在失败时**源文件仍在**
（`:258` 注释"宁可不轮转，也不能丢日志"）。**判断与实现均正确。**

### 3.2 task-6 第 4 条的三个具体问题 —— 明确回答

1. **flush 是否可能抛异常导致 App 崩？** → **不会。**
   `safeRun` / `safeRunAsync`（`:69-89`）双层 try/catch，且内层 `console.log` 再包一层 try
   （`:74-76`、`:85-87`），连"打日志本身炸掉"都防住了。
   `doFlush` 的 `catch`（`:391-406`）把内容放回队列并计数，**绝不 rethrow**。
   所有 fs 调用均带 `.catch`。**结论：日志模块不会成为新的崩溃源。** ✅

2. **热路径是否有同步 IO 阻塞？** → **无同步 IO。**
   `write()`（`:455-463`）只做内存 `push`（`pushEntry` `:416-441`），
   IO 全部在 `doFlush` 的**异步**分支。高频回调（`PlaybackState` 每次 state 变化、
   `playProgress` 1s 轮询）不会阻塞 JS 线程。
   - 残留成本：每次调用执行 `formatTimeText` + 字符串拼接（`:417-425`）—— **纯 CPU**，
     不阻塞但增加 GC 压力。T3 已对高频路径节制埋点（`playProgress.ts:42` 注释"仅失败时记"）。
   - **结论：可接受。** ✅

3. **轮转是否真能限制文件大小？** → **能，但有一个诚实的边界。**
   - 判定用 `readSize()`（`fs.stat` 的**真实字节数**）为权威（`:361`/`:382`），
     累加值 `utf8ByteLength()` 仅作估算 —— 口径统一且正确 ✅
   - 默认 `maxFileSize = 512KB`、`maxBackupCount = 2`（`:48-49`）→
     磁盘上限 ≈ **1.5MB**（主文件 + 2 备份），**不再无限增长** ✅
   - **边界**：`:268-271` 注释明确 —— 搬运失败时**宁可放弃本次轮转、让文件暂时超过阈值**，
     也不丢日志。此时文件会暂时超标，但**下一次 flush 会用真实大小重试轮转**，不会永久失效。
     这是**正确的取舍**（保证据优先于保大小）。

### 3.3 T2 审查结论
**✅ 通过。** 6 项发现全部真实修复。task-6 第 4 条关注的
"日志模块是否会成为新的故障源" → **否**。

---

## 4. 埋点覆盖度核对（对照 `evidence.md` L1-L25）

**方法**：逐条到源码中 grep 对应 tag/调用点，确认是否落地。

### 4.1 ✅ 已落地（17 条）

| # | evidence.md 要求 | 落地位置（verifier 核实） |
|---|---|---|
| L1 | `PlaybackError` ERROR + 立即 flush | `service.ts:91-107` ✅ 含 code/message/trackId/gettingUrlId/isTempId/isEmpty/isPlayedStop + `void flush()` |
| L2 | `PlaybackState` 状态迁移 | `service.ts:114-164` ✅ 含 state 名/position/两守卫标记；守卫命中单记 `:125-132` |
| L3 | `PlaybackTrackChanged` | `service.ts:165-177` ✅ 含 track/nextTrack/prevTrackId/playerTrackId/isEmpty |
| L4 | 服务注册 | `service.ts:35-42`、`:271-272`、`:276-283` ✅ 含守卫与重复注册 |
| L5 | `initial()` 每步 + try/catch + 参数 | `plugins/player/index.ts:21-86` ✅ 参数（volume/playRate/cacheSize/audioOffload）与各步起止耗时；**注：`try/catch` 按第 2.3 节结论刻意不加**（加它会改变行为，属正确判断） |
| L6 | 原生调用前后 + 超时升 WARN | `plugins/player/utils.ts` ✅ `setStop` `:173-186`（含 `stop()`/`skipToNext()` 分段耗时）、`setPlay` `:159-166`、`updateOptions` `:333-339`；`destroy`/`migratePlayerCache` 亦有。**未实现"超时升 WARN"**（见 4.2 L6 备注） |
| L7 | `playList.ts` 四个 await + `.catch` | ❌ **未落地**（该文件不在 T3 写入范围；见 BUG-2）→ 计入 4.2 |
| L9 | `handlePlay` 进入/退出 + `setStop` 耗时 | `core/player/player.ts:300-371` ✅ 含 `setStop` 单独耗时 `:350-355` |
| L10 | `setMusicUrl` 全流程 | `core/player/player.ts:187-225` ✅ 含守卫跳过/成功/失败/finally |
| L11 | `delayRetry`/`getMusicPlayUrl` 重试轮次 | `core/player/player.ts:86-184` ✅ 含 `isRetryed`、`tooManyRequests`、换源 source、每次递归 |
| L12 | 25s 加载超时 + 两分支 | `playerEvent.ts:29-44` ✅ 含 `prevTimeoutId` 判定与两分支 |
| L13 | `handleError` | `playerEvent.ts:119-163` ✅ 含 retryNum/isEmpty/isActive |
| L15 | `playNext` 进入/退出 | `core/player/player.ts:516-662` ✅ **全部 10 条出口**均含 elapsed |
| L16 | 预加载开始/成功/失败/超时 | `preloadNextMusic.ts:29-69` ✅ 含 `isLoading` 锁未释放告警 `:97` |
| L17 | `getDuration`/定时器/心跳 | `playProgress.ts` ✅ `:43` `getPosition` 失败、`:71` 屏灭跳过、`:123` playerError 停轮询、`:181/192` 屏幕状态 |
| L19 | `core/init/index.ts` 每步落盘 | `core/init/index.ts:51-109` ✅ `info('BOOT', init step: ...)` + bootLog + `markEvent` + 末尾 `await flush()` |
| L20 | `app.ts` 各阶段 + catch 落盘 | `app.ts:45-191` ✅ 模块加载/字体/import/handleInit/pushHomeScreen 各阶段，三个 catch 分支均**先 logError + flush 再走原流程** |
| L22 | `errorHandle.ts` ERROR + 立即 flush | `errorHandle.ts:30-41` ✅ 含播放上下文 + `getSnapshot(200)` + `getWatchdogSnapshot()` + `flushSyncBestEffort()` |
| L21 | `regLaunchedEvent` launched 标志 | `navigation/regLaunchedEvent.ts:12-20` ✅ 含 `launched` 状态与 flush。**未实现"X 秒未收到 appLaunched 则强制 push"兜底**（属行为变更，见 4.2） |

### 4.2 ❌ 未落地（8 条）—— 逐条说明与风险判定

| # | evidence.md 要求 | 未落地原因 | 风险判定 |
|---|---|---|---|
| **L6** | 原生调用**超过阈值（如 3s）升为 WARN** | 只做了耗时记录，未做阈值告警 | 🟢 **低**。耗时值已记录，事后可在日志里人工筛出慢调用，**排查能力未损失** |
| **L7** | `playList.ts:150-185` 的 4 个 `TrackPlayer.*` await 各自耗时 + **加 `.catch` 记录 rejection** | **该文件不在 T3 的写入范围**（任务硬性约束），且改 `.finally`→`.catch` 属行为变更 | 🟠 **中**。这是 **BUG-2** 的观测缺口：`handlePlayMusic` 的失败仍被 `.finally` 静默吞掉，**日志里看不到**。属**已知并有意保留**的缺口 |
| **L8** | `playMusic()` 连续调用序号/被丢弃调用/长期 pending | 同上（`playList.ts` 不在范围） | 🟡 **低** |
| **L14** | `core/init/player/player.ts` `handleEnded` 是否 `isPlayedStop` + `playNext(true)` 前后 | **确实未埋**（verifier 核实该文件 `:20-61` 无任何 runtimeLog 调用）。该文件**不在 T3 写入范围** | 🟠 **中**。"播放结束→自动切下一曲"这一环无日志，若**自动连播**停摆则难以定位。属**范围限制导致的可观测缺口** |
| **L18** | `nativeModules/utils.ts` 权限弹窗 Promise 何时 resolve/是否永不 resolve | **确实未埋**（verifier 核实无 runtimeLog）。该文件**不在任何任务的写入范围** | 🟠 **中**。recon 将其列为 Q2-a 的**无超时 await**（`player.ts:310-311` 首次播放时先 await 它）。若用户跳系统设置后不返回，**Promise 永不 resolve 且无日志** |
| **L23** | `plugins/storage.ts` 已有 `log.error` 处**补 flush** | **确实未补**（verifier 核实该文件无 `flush`/`runtimeLog` 引用）。该文件不在任何任务写入范围 | 🟡 **低-中**。`storage.ts` 的 `log.error` 现经 `writeLegacy` 走批量 flush（2s/20 条），崩溃时**最多丢 2 秒**的日志 |
| **L24** | 全局内存水位周期采样（`playedList.length` 等） | `recordMemory()`/`startMemorySampling()` **已实现但无任何调用点**（verifier 全仓 grep 确认只在 `runtimeLog.ts` 内定义与导出）。T4 未接入 | 🟠 **中**。**"长时间听歌内存压力"正是根因假设之一，却没有任何内存水位日志**——这是本次交付最明显的观测缺口。且 `recordMemory` 在正式版 RN 通常因无 `performance.memory` 而降级 no-op（见第 7 节） |
| **L25** | `MainActivity.java` 新增 `onTrimMemory`/`onLowMemory` → 转 JS 日志 | 任务明确"**不修改 android/ 原生代码**"，仅建议 | 🟢 **低**（符合任务约束）。但**系统内存压力信号仍完全不可见** |

### 4.3 覆盖度小结
- **17/25 已落地**，覆盖了**故障主干**：错误（L1）、状态机（L2/L3）、URL 获取与换源（L10/L11）、
  切歌（L15）、预加载（L16）、启动（L19/L20）、崩溃上下文（L22）。
- **8 条未落地**，其中**5 条（L7/L8/L14/L18/L23）源于"文件不在写入范围"**——
  这是任务切分**有意的边界**，不是执行失误；**2 条（L24/L25）源于任务约束**（不改原生、T4 未接入）。
- **唯一"本可做到却没做"的是 L24（内存采样已实现但无人调用）**——建议后续接入。
- **对本次目标的影响**：用户症状的**主路径（播放/URL/状态机/启动/崩溃）已全部可观测**，
  8 条缺口**均不阻塞**"定位长时间听歌挂掉"这一目标，但会**降低对
  "内存压力型根因"和"自动连播停摆"的定位精度**。

---

## 5. T5 UI 与 i18n 审查

### 5.1 ✅ i18n 三语齐全
`src/lang/{zh-cn,zh-tw,en-us}.json` 各新增 **8 个 key**，**按字母序插入**，**未改动任何既有 key**：
`setting_other_log_btn_clean_file`、`..._btn_copy_diagnostics`、`..._btn_share`、
`..._btn_show_runtime`、`..._clean_file_confirm`、`..._runtime_path`、
`..._path_unavailable`、`..._share_desc`/`..._share_title`。
verifier 逐一对比三语，**键名完全一致、无遗漏** ✅

### 5.2 ✅ 已修复缺陷：清空按钮错位（**由 verifier 发现**）

**位置**：`Log.tsx:160-161` + `:53-58`（初版）

**证据链**（verifier 独立复核，Lead 已二次确认）：
```ts
L26   const [logText, setLogText] = useState('')
L44   setLogText(splitLegacyLog(log))   // openLogModal → error.log 内容
L67   setLogText(text ? ... : '')       // handleShowRuntimeLog → runtime.log 内容 ← 复用同一 state
L160  onConfirm={handleCleanLog}        // 恒定只清 error.log
L161  showConfirm={!!logText}           // logText 非空即显示可点的"清空"按钮
```
`handleCleanLog`（`:53-58`）→ `clearLogs()` → `clearLegacyLogFile()` → **只删 `error.log` + 备份**。
`ConfirmAlert.tsx:118-120` 确认 `showConfirm` 为真时**确实渲染可点的确认按钮**。

**用户操作路径与后果**：
1. 点"查看运行时日志" → `logText` = runtime.log 全文 → 弹窗打开；
2. `showConfirm=!!logText` = **true** → 出现"清空"按钮；
3. 用户理解为"清空我正在看的这份日志"，点击；
4. 实际**删除 `error.log` 及备份**，而**正在看的 `runtime.log` 一字未删**；
5. `getErrorLog()`（`:56`）又把 `logText` 覆盖为 error.log 内容 → 用户**误以为 runtime.log 已清空**。

**为何在本任务语境下严重**：用户核心诉求是"出问题后能拿到日志"。
该缺陷让用户在不知情下**删掉 error.log 证据**，同时**误以为 runtime.log 也清了**（于是不去导出）
→ **两份证据同时丢失**，正是本任务要消灭的"无法排查"。

#### 5.2.1 ✅ 终态复核（verifier 独立读码确认）

logui **未采用** Lead 建议的方案一（`showConfirm={!!logText && !isShowingRuntimeLog}` 隐藏按钮），
而采用方案二（按来源路由）。**verifier 认可其理由，且实测确认修复正确**：

logui 拒绝方案一的论证（verifier 认为是**正确的技术判断**）：
> 方案一只保证**单向**不变量 —— 它在 runtime.log 视图下让按钮**消失**，
> 用户就无法清空 runtime.log，而 runtime.log 恰是新增的、会轮转增长（512KB × 3）的那份，
> **实际最需要清空入口**。Lead 的要求"清掉的一定是当前展示的那份"是**双向**要求；
> 方案一在 runtime.log 方向不是"清对了"，而是"不能清"。

**终态证据**（verifier 逐行核对）：
| 行号 | 内容 | 复核 |
|---|---|---|
| `:30-32` | 新增 `isShowingRuntimeLog` state（false=error.log，true=runtime.log） | ✅ |
| `:51-56` | `openLogModal` 先 `setIsShowingRuntimeLog(false)` | ✅ |
| `:58-64` | `handleCleanLog` 补上原本缺失的卸载守卫（`isUnmountedRef`），且**置于 `toast` 之前** | ✅ 顺带修正了原有缺陷 |
| `:66-84` | 新增 `handleCleanShowingLog`：`false` → `handleCleanLog()`；`true` → `confirmDialog` → `clearLogFiles()` | ✅ 双向均正确 |
| `:92` | `handleShowRuntimeLog` 成功回调置 `setIsShowingRuntimeLog(true)` | ✅ |
| `:96-100` | **新增 `.catch`** → `toast(t('setting_other_log_tip_read_failed'))` | ✅ 修复 5.3 |
| `:143` | `handleCleanLogFiles` 改为 `if (isShowingRuntimeLog) setLogText('')`（原无条件置空） | ✅ 更精确 |
| **`:192`** | **`onConfirm={handleCleanShowingLog}`** —— 弹层唯一改动的一行 | ✅ |

**不变量推演（verifier 独立验证，四条路径全部成立）**：
| 路径 | 点"清空"实际删除 | 与展示内容一致 |
|---|---|---|
| 查看日志（error.log） | `clearLogs()` → error.log | ✅ |
| 查看运行时日志 | 二次确认 → `clearLogFiles()` → runtime.log + .1/.2 | ✅ |
| 独立按钮"清空日志文件" | runtime.log + 备份 | ✅ |
| 取消二次确认 | 不删任何东西 | ✅ |

**未改动项**（verifier 确认）：`showConfirm={!!logText}`（`:193`）、`splitLegacyLog` 正则（`:17-21`）、
`ConfirmAlert` 其余 props、既有 error.log 页面的全部功能 ✅

**i18n**：新增 `setting_other_log_tip_read_failed` 按字母序插入
（zh-cn `:360` / zh-tw `:360` / en-us `:360`），**三语齐全** ✅

### 5.3 ✅ 已修复：`handleShowRuntimeLog` 的 `.then` 链缺 `.catch`
终态 `Log.tsx:96-100` 已补 `.catch` → 读日志失败时 `toast` 明确提示，
**用户不再"点了没反应"** ✅（且 `.catch` 内同样有 `isUnmountedRef` 守卫，正确。）

### 5.4 T5 审查结论
i18n ✅ 齐全；UI 新增功能**设计合理**（复用既有 `ConfirmAlert`/`Button` 组件、
无新依赖、显示磁盘路径、含二次确认的破坏性操作、`isUnmountedRef` 防卸载后 setState）。
**1 处用户可见缺陷 + 1 处健壮性缺陷，均已派单**，修复后需复核终态。

---

## 6. 对 Lead 原生侧结论 F1 的独立复核（**推翻**）

> Lead 明确要求对抗性验证，并声明"如果你的复核与我的结论冲突，以你的为准"。

### 6.1 ❌ F1 不成立：前台服务与 WakeLock 权限**存在**

Lead 原结论（`lead-native-findings.md` F1）：Manifest 缺少 `FOREGROUND_SERVICE`、`WAKE_LOCK`，
且无任何 `<service>` 声明 → 后台播放被冻结/杀死。

**verifier 找到的铁证**（Lead 要求查证的关键点）：

`node_modules/react-native-track-player/android/src/main/AndroidManifest.xml`（全文 26 行）
```xml
L5   <uses-permission android:name="android.permission.WAKE_LOCK" />
L6   <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
L11  <service android:name=".service.MusicService" android:enabled="true" android:exported="true">
L18  <receiver android:name="androidx.media.session.MediaButtonReceiver" android:exported="true">
```

**更决定性 —— 已打包进 release APK 的合并清单**
`android/app/build/intermediates/packaged_manifests/release/processReleaseManifestForPackage/arm64-v8a/AndroidManifest.xml`
```
L20  <uses-permission android:name="android.permission.WAKE_LOCK" />
L21  <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
L137-144  <service android:name="com.guichaguri.trackplayer.service.MusicService"
                   android:enabled="true" android:exported="true" >
```
这是 **packaged_manifests** 阶段产物，即**真正进入 release APK 的最终清单**。

### 6.2 误判原因（方法论教训，值得记录）
Lead 的 grep 范围是 `android/` 目录 → 零命中；但声明位于 **node_modules 内 library 的 manifest**，
由 Gradle **manifest merger** 自动合并进 app。
**只读 app 的 `src/main/AndroidManifest.xml` 无法判断权限是否齐全。**
→ "零命中 ≠ 缺失，只是没搜 node_modules"。

### 6.3 交叉印证
`recon` 的 `evidence.md:212-218` **独立得出同一结论**（三份独立证据一致）：
| 项 | 状态 |
|---|---|
| `WAKE_LOCK` 权限 | **有**（来自 RNTP library manifest 合并） |
| `FOREGROUND_SERVICE` 权限 | **有** |
| `MusicService` 声明 | **有** |
| `foregroundServiceType` | **缺失** ← 唯一的真实缺口 |
| `targetSdkVersion` | **29** |

### 6.4 ✅ 仍成立 / verifier 补充的发现

1. **`foregroundServiceType` 缺失确实存在** ✅ —— 但**当前是潜伏缺陷，不是崩溃原因**：
   该属性的强制要求自 **targetSdk 34（Android 14）** 起生效（缺失会抛
   `MissingForegroundServiceTypeException`）；本工程 targetSdk=29，**当前不会因此崩溃**。
   → 准确表述是"**侥幸合规**"，而非"当前故障原因"。

2. **`targetSdkVersion = 29` 与 `compileSdkVersion = 36`**（verifier 补充，Lead 漏掉）：
   - 源码确认：`android/build.gradle:6-8` `minSdkVersion=21`、`compileSdkVersion=36`、`targetSdkVersion=29`。
   - **用最新 SDK 编译，却按 Android 10 的行为规则运行** → 系统会为该应用开启**大量兼容性 shim**。
   - 这改变了"哪些系统限制会作用于本 App"的判断，是任何后台播放/白屏归因**必须纳入的前提**。
   - **不得**写成"已确认根因"，属**待真机日志验证的高价值假设**。

3. **`largeHeap` 确实缺失** ✅（打包清单 grep 零命中）——F2 此部分成立。

### 6.5 复核对"玩游戏时更易复现"的影响
**不能**再用"缺少前台服务"解释。合理的方向应改为：
- 后台进程被 LRU 回收 / Doze（**与是否有前台服务无关**——前台服务能降低被杀概率但不能免疫，
  且用户玩游戏时内存竞争最激烈）；
- JS 侧无超时 `await` 卡死（recon Q2 方向，本报告第 7 节）；
- 累积型内存增长（recon Q4）；
- targetSdk 29 在 Android 12+ 真机上的兼容行为差异。
**以上均需真机日志确认 —— 这正是本次埋点交付的价值。**

### 6.6 ⚠️ 交付红线
**最终交付中不得出现"缺 `FOREGROUND_SERVICE`/`WAKE_LOCK` 权限"这一结论**，否则会把用户
引向无效的修复方向。`lead-native-findings.md` 已由 Lead 更正为 F1「❌ 已被推翻」。

---

## 7. 未验证项与残余风险

### 7.1 因无法运行命令而**完全未验证**的项

| 项 | 影响 | 严重度 |
|---|---|---|
| ~~`npx tsc --noEmit`~~ | ✅ **已解决**（`b2b3dab` 修复 5 处类型错误后，`npm run tsc` = 0）。⚠️ **由 Lead 实测，verifier 未亲测**。注意：**该脚本原工程不存在，用户在本轮新增** | ✅ 已关闭 |
| ~~`npx eslint`~~ | ✅ **已解决**（`75ba8d04` 修复 27 error + 1 warning 后，`npm run lint` = 0）。⚠️ **由 Lead 实测，verifier 未亲测**。其引入的 12 文件改动已由 verifier 在 §10 加性复核**确认未夹带业务改动** | ✅ 已关闭 |
| **`git diff --stat` / `git status`** | verifier 侧仍**无法从 git 层确认**改动面（shell 不可用）。T3 的 11 文件有**逐字基线**覆盖；`caaed5a→75ba8d04` 层有 **Lead 代跑的 diff 原文**支撑（§10） | 🟡 低（已由 §10 缓解） |
| **是否存在越界改动** | verifier 只能靠**读终态 + 与已知范围比对**；**不能排除**有文件被静默改动而未被覆盖检查。§10 已就 Lead 提供的 diff 逐一核对 | 🟡 低-中 |
| **真机运行** | 无任何运行时验证：日志能否落盘、轮转是否触发、`markEvent` 是否如预期、UI 是否正常渲染。**新增**：`PLAY_LATER`（`listId === null`）路径未验证（§10.5） | 🔴 **高（现为最大残余风险）** |

> **风险排序变化**：原"最高风险"（tsc/eslint 从未运行）**已由门禁关闭**。
> **当前最大残余风险是"真机运行时未验证"** —— 门禁只能证明"能编译、无 lint error"，
> **不能证明日志功能在设备上真的工作**。

### 7.2 静态审查**覆盖不到**的风险

1. ~~**类型/编译错误**~~ → ✅ **已由 `npm run tsc` = 0 关闭**（§10.0）。
   保留一条边界：该结果**由 Lead 实测、verifier 未亲测**；且 `tsc` 通过**不代表运行时正确**。

2. **运行时行为**（**当前最高风险**）：`setInterval` 看门狗是否真能检测阻塞、
   `flush` 的异步时序在真机 RN 桥下是否如预期、`unref()` 在 Hermes 下是否可用
   （`runtimeLog.ts:227`、`:730` 均有 `typeof unref == 'function'` 保护，**降级安全** —— 见 §10.2）。
   **新增待验**：`player.d.ts` 放宽后，`PLAY_LATER`（`listId === null`）路径的播放/切歌/进度保存（§10.5）。

3. **真实 UTF-8 文件大小**：`utf8ByteLength` 为**手写实现**，未经真机实测验证。
   逻辑上正确（verifier 已逐分支核对 ASCII/2字节/3字节/代理对），
   但**未与 `Buffer.byteLength` 或实际文件大小比对**。

4. **原生侧**：Manifest 合并结果基于**历史构建产物**（已用 `build.gradle` 交叉确认未滞后），
   但**未重新构建**验证。

5. **内存采样大概率无效**（重要）：
   `runtimeLog.recordMemory` 依赖 `global.performance.memory`（`:544-552`）。
   该能力在 **Hermes/正式版 RN 中通常不存在** → 会降级为 no-op 并记一条 warn
   （`:563-567`，**只 warn 一次，设计正确**）。
   **且 `startMemorySampling` 目前无任何调用点**（见 4.2 L24）。
   → **因此"长时间听歌内存压力"这一根因假设，本次交付实际上仍未获得直接观测手段。**
   这是**最需要用户/后续开发者注意的观测盲区**。

### 7.3 `flushSyncBestEffort` 的固有限制（平台限制，非缺陷）
RN **没有真正的同步文件写**。`flushSyncBestEffort`（`:513-518`）只是发起 flush 并返回 Promise。
- 在 `errorHandle.ts:40` 的**同步**崩溃处理路径中，若进程在 flush 完成前被杀，
  **日志仍会丢失** —— 这是**平台限制**。
- **缓解**：`flushInterval=2000` / `flushBatchSize=20`（`:50-51`），最坏丢失窗口约 2 秒。
- **建议**（已记录在 JSDoc `:502-511`）：调小这两个值可缩小丢失窗口。

### 7.4 ✅ 建议用户在真机上做的最终验收（最高优先级）

**以下步骤是本次交付能否真正落地的唯一判据** ——
门禁（tsc/lint）已绿，但它只证明"能编译、无 lint error"，
**不能证明日志功能在设备上真的工作**。

1. **编译/门禁验证**：✅ **已完成**（`npm run tsc` = 0、`npm run lint` = 0，**Lead 实测**）。
   - 注：这两个脚本中 `tsc` 是**本轮新增**的；`package.json` 原本既无 `tsc` 也无任何测试框架。
   - 建议保留该门禁（**先门禁绿、再人工复审**的顺序更稳，见 §10.8 教训）。

2. **冒烟测试**：启动 App → 进设置-其他-日志 → **确认新增的三个按钮**（查看运行时日志/
   分享日志/复制诊断信息）与**运行时日志路径**正常显示 → 点"查看运行时日志"确认有内容。

3. **核心场景复现**（对应用户症状）：
   - 正常听歌 10 分钟，切歌数次 → 导出日志，确认有 `[PLAYBACK]`/`[MUSIC_URL]` 记录；
   - **长时间 + 游戏后台**：听歌 → 切到游戏 20-30 分钟 → 回来观察是否复现；
   - 复现后立即导出日志（**在应用被杀之前**）。

4. **⚠️ 新增必测项：`PLAY_LATER`（"稍后播放"）路径**（对应 §10.5 的类型放宽）
   - 用「稍后播放」加入歌曲并播放 → 确认**播放、切歌、进度保存**均正常。
   - 理由：`listId` 类型放宽为 `string | null` 后，**编译器不再强制检查该路径的 null 处理**，
     若存在遗漏的 null 判断，缺陷会推迟到运行时暴露。**这是本轮类型改动唯一需运行时确认的点。**

4. **重点看**：用 `[STALL]` 判断 JS 线程是否被阻塞；用 `[PLAYBACK_ERROR]` 看错误码；
   用 `[BOOT]` 看白屏卡在哪一步。详见《用户排查操作指南.md》。

5. **验证轮转**：日志量大时确认出现 `runtime.log.1` / `.2` 且总大小 ≈ ≤1.5MB。

6. **待 logui 修复后**：单独验证第 5.2 节的清空按钮错位已修
   （点"查看运行时日志"→ 弹窗的"清空"**不得**删除 error.log）。

---

## 8. 交付物与任务完成度

### 8.1 task-6 要求逐条对应

| # | task-6 要求 | 状态 |
|---|---|---|
| 1 | `npx tsc --noEmit` | ❌ **未能执行**（沙箱故障，已豁免）→ 见 7.1 / 7.4 |
| 2 | `npx eslint src --ext ...` | ❌ **未能执行**（同上） |
| 3 | **逻辑回归审查** | ✅ **完成**（第 2 节，T3 全部 11 文件逐行对照基线） |
| 4 | 日志自身安全性审查 | ✅ **完成**（第 3 节，6 项含 3 CRITICAL，给出行号论证） |
| 5 | 埋点覆盖度核对 | ✅ **完成**（第 4 节，17/25 落地，8 条缺口逐条定性） |
| 6 | 执行工程测试/构建脚本 | ✅ **完成**（已盘点：**无 `tsc` 脚本、无 `test` 脚本、无测试框架**，无对象可执行） |
| 附 | 《用户排查操作指南.md》 | ✅ 见同目录 |

### 8.2 关于第 6 条的重要发现
`package.json` 中：
- **不存在 `tsc` / `typecheck` 脚本** → task-6 与 T2/T3/T4/T5 验收项中的
  `npx tsc --noEmit` 只能靠直调 `npx tsc`。
- **不存在 `test` 脚本，且 devDependencies 无任何测试框架**
  （无 jest/mocha/vitest，无 `@testing-library/*`）。
  → **本工程没有任何可运行的单元/集成测试。**
  → 这意味着本次交付（一个日志模块 + 遍布热路径的埋点）**没有任何自动化测试保障**，
  只能依赖静态检查 + 人工审查 + 真机验证。**这放大了第 7.1 节的风险。**
- `lint` 脚本是 `eslint .`（**全仓**，非 task-6 描述的 `src`）；
  `lint:fix` **不要运行**（会改文件，违反 verifier 只读约束）。

### 8.3 verifier 的产出文件
| 文件 | 内容 |
|---|---|
| `.diagnosis/verification.md` | **本文件**（主报告） |
| `.diagnosis/用户排查操作指南.md` | 面向非开发者的复现+抓日志指南 |
| `.diagnosis/baseline-git.txt` | **改动前基线原文**（替代 git diff 的核心证据） |
| `.diagnosis/baseline-tooling-probe.txt` | 工具不可用的原始证据 |
| `.diagnosis/verifier-t2-safety-review.md` | T2 模块安全性专项审查（含修订前记录） |
| `.diagnosis/verifier-native-review.md` | 原生侧 F1 复核（含推翻论证） |

### 8.4 verifier 的独立性声明
- 本报告所有结论基于**独立读取源码**，未采信任何队友的报告结论
  （对 T2 的 6 项修复、T3 的等价性、Lead 的 F1，均**重新读码验证**）。
- 唯一采信外部输入的是 `evidence.md` 的 **L1-L25 清单本身**（作为核对基准），
  但**每条的落地情况均由 verifier 到源码中独立 grep 确认**。

---

# 9. 增量复查：`src/app.ts` 的"覆盖度补修"（**在 task-6 complete 之后发生**）

> **背景**：task-6 完成（status=completed）后，boottrace 按 Lead 指示又对 `src/app.ts`
> 做了一轮改动（接入内存周期采样，2 个文件：`app.ts` + `t4-report.md`），
> 并**未 reopen task-4**。
> ⚠️ **这使 verifier 此前对 `app.ts` 的审查结论失效（stale）** —— 第 2/4 节中关于
> `app.ts` 的描述基于改动前的版本。verifier 据此执行**增量复查**，本节结论为最新。
> 这也是本报告需要强调的一条流程风险：**已完成的验证在后续写入后会失效**。

## 9.1 复查范围与结论
**结论：✅ 通过。** 改动为**纯增量**，未引入业务分支变更。
唯一发现是 **1 处报告行号偏差**（文档问题，非代码缺陷）。

## 9.2 逐项复核 boottrace 提出的 4 个复核点

| # | boottrace 的主张 | verifier 独立核实 | 结论 |
|---|---|---|---|
| 1 | `stopMemorySampling` 被模块级 const 持有，未丢弃 | `app.ts:63` `const stopMemorySampling = startMemorySampling(30000)` ✅ 确为模块级 const | ✅ 成立 |
| 2 | **未调用**停止函数、**未加** AppState 启停逻辑 | `app.ts:62` 注释明确"按约束**不调用**停止函数，也不加 AppState 启停逻辑"；AppState 监听器 `:215-224` **只**做 `info`+`markEvent`+`flush`，**确无任何采样启停** ✅ | ✅ 成立（符合 Lead 约束） |
| 3 | 采样**零业务分支影响** | 新增内容仅：`:11-20` 两个 import、`:63` 一次 `startMemorySampling`、`:64-68` 一条 `info` 日志。**未插入任何条件分支**；`handleInit`（`:87-125`）、`pushHomeScreen`（`:170-189`）、`isInited`（`:76/124/131/161`）、`tipDialog`/`exitApp`（`:114-121`/`:181-188`/`:199-206`）控制流**与改动前逐字一致** ✅ | ✅ 成立 |
| 4 | 报告行号已 +14 重算 | **抽查 7 个锚点，6 个正确、1 个偏差**（见 9.3） | ⚠️ **1 处偏差** |

## 9.3 行号抽查结果（verifier 逐行核对实际文件）

| boottrace 声称 | verifier 实际读到的 | 结果 |
|---|---|---|
| `void initRuntimeLog()` = `:44` | `:45` | ❌ 偏差 1 行 |
| `void initLog()` = `:94` | `:95` | ❌ **偏差 1 行** |
| `await flush()`（handleInit catch）= `:112` | `:113` | ❌ 偏差 1 行 |
| 超时块 `setTimeout(async()=>` = `:133` | `:130` | ❌ 偏差 3 行 |
| 超时 `await flush()` = `:146` | `:147` | ❌ 偏差 1 行 |
| `AppState.addEventListener('change', async(state)` = `:214` | `:215` | ❌ 偏差 1 行 |
| AppState `await flush()` = `:219` | `:220` | ❌ 偏差 1 行 |

**说明**：boottrace 称"本轮新增 2 行 import 使全部后续行号 +14"，但 verifier 实测
**其声称值与实际值系统性相差 1~3 行**（多数为 +1，超时块为 -3）。
→ **`t4-report.md` 的锚点行号整体需要重算**（1 处已列入第 0 节问题清单 #6）。
- **性质**：**纯文档问题**，不影响代码正确性。
- **影响**：若后续有人按报告的锚点行号去定位代码，会**错位 1~3 行**（通常仍能附近找到，
  但会影响精确定位）。建议 boottrace 用实际文件重新校准。

## 9.4 对新增内存采样的独立安全评估

**1) 是否引入资源泄漏？** → **否（且设计正确）。**
- `app.ts:63` 持有停止函数（**未丢弃**），`:62` 注释说明了为何不调用。
- `runtimeLog.ts:730` 有 `if (typeof timer?.unref == 'function') timer.unref()` 保护，
  Hermes 无 `unref` 时**安全降级**。
- 30s 一次 `recordMemory()`（`runtimeLog.ts:720-728`）开销极低（`setInterval` + 一次属性读取）。
- ⚠️ **次要观察**：`setInterval` 在进程生命周期内**永久运行**。这是 boottrace **有意为之**
  并已获 Lead 约束确认（"进程内持续采样"）。在 RN 中 `setInterval` 会在后台被节流，
  **不构成实际资源问题**。verifier 认可该取舍。

**2) 是否会影响启动性能？** → **否。** `:63` 在模块加载期同步执行，但
`startMemorySampling` 内部全部包在 `safeRun`（`runtimeLog.ts:722`）中，
且首次 `recordMemory()` 在无 `performance.memory` 时**立即 return**（`:688-694`）。

**3) boottrace 指出的"init 前入队、init 后回灌"路径 —— verifier 已独立验证：**
- `app.ts:45` `void initRuntimeLog()` 是**异步且未 await**；
  `app.ts:63` `startMemorySampling` 紧随其后**同步执行**，其首次 `recordMemory()` → `info()`
  → `pushEntry()`（`runtimeLog.ts:416-441`）。
- 此时 `state.isReady` 大概率为 `false`（因为 `init()` 的 `await ensureFileReady()` 尚未 resolve，
  见 `runtimeLog.ts:487`）→ `pushEntry` 会在 `:435` `if (!state.isReady) return` 处**提前返回**，
  日志**只进内存 `entries`、留在 `pending` 队列**。
- 随后 `init()` 在 `:494` `if (state.pending.length || state.legacyPending.length) await flush()`
  将其**回灌落盘** ✅
- **结论：该路径真实存在且工作正常**，是 T2 "init 前可安全调用"设计的真实使用场景，
  **无缺陷**。verifier 确认此前的设计评估成立。

**4) `performance.memory` 不可用是否为缺陷？** → **不是，属预期行为。**
`runtimeLog.ts:688-694`：不可用时**只记一次** `WARN`（`state.hasWarnedMemoryUnsupported` 门控，
`:689-692`）并降级 no-op，**不会刷屏**。
→ 报告中**不得**将"采样没有数据"判为缺陷；那道 warn 本身就是"本设备无法提供 JS 堆水位"
的有效诊断信息 ✅（与 boottrace 的说明一致，verifier 独立确认）

## 9.5 对残余风险清单的影响（更新第 7 节）

- **7.2 节第 5 条需修订**：原结论"内存采样大概率无效 + **`startMemorySampling` 无任何调用点**"
  → **现已接入**（`app.ts:63`）。
  但**"`performance.memory` 在正式版 RN 通常不存在"这一限制不变**，
  故**内存水位在多数真机上仍可能采样不到**。
- **4.2 节 L24 的状态应更新**：从"已实现但无调用点"→ **"已接入（`app.ts:63`），
  但实际有效性取决于设备是否提供 `performance.memory`"**。
  即 **L24 由"未落地"改为"已落地（有设备依赖）"**。
  → **覆盖度计数从 17/25 更新为 18/25**（"有条件的"落地）。
- **新增残余风险**：内存采样的**有效性未被验证**（无真机、无 `performance.memory`），
  因此"长时间听歌的内存压力"这一根因假设，**仍然缺乏可直接确认的手段**。
  建议用户在真机上检查日志中是否出现 `INFO [MEMORY] memory usedMB=...`；
  若只有那条 `unavailable` 的 warn，则说明该设备无法提供 JS 堆水位。

## 9.6 流程改进建议（供 Lead 参考）
本次出现"验证完成后代码又被修改"的情况。建议后续：
1. **任何写操作都应在写入后重新触发相关验证**（或 reopen 对应 task），
   避免"已验证"的结论静默失效。
2. verifier 的结论应**附带被验证文件的版本/行号快照**（本报告已对 T3 的 11 个文件做到）。
3. `t4-report.md` 类文档的行号建议在最终定稿时统一重算（本次已发现系统性 1~3 行偏差）。

## 9.8 问题 #6（行号偏差）闭环 + `app.ts` 冻结确认

boottrace 已回复并修正，verifier **复核确认闭环**：

### ① 行号偏差已修正（verifier 复测一致）
boottrace 改用 grep 实测，7 个锚点与 verifier 读数**逐条一致**。
verifier **再次独立复测**（读文件 + grep 双确认），当前**实际值**：

| 锚点 | 实际行号（verifier 复测） | boottrace 修正后 |
|---|---|---|
| `void initRuntimeLog()` | **45** | 45 ✅ |
| `void initLog()` | **95** | 95 ✅ |
| `await flush()`（handleInit catch） | **113** | 113 ✅ |
| `setTimeout(async()=>`（超时块） | **130** | 130 ✅ |
| 超时 `await flush()` | **147** | 147 ✅ |
| `AppState.addEventListener(...)` | **215** | 215 ✅ |
| AppState `await flush()` | **220** | 220 ✅ |

**根因**（boottrace 确认，与 verifier 推断一致）：`:11-20` 的 import 块实际 **10 行**
（`import {` + 8 个成员 + `} from`），此前按 9 行统计 → 系统性 +1 漂移。

boottrace 并做了**超出问题清单 #6 范围**的全量清扫：另修正 6 处遗漏，
**重算 2.1 埋点表全部 30 行**，并**补上此前漏列的一行** `:194-197` `boot prerequisites failed`。
verifier 认可此处理 —— **从"修单点"扩展到"修同类全部"，是正确的收敛方式**。

### ② 问题 #6 状态更新：✅ **已解决（RESOLVED）**
> 由 🟡 低（未解决）→ ✅ **已修正并复核**。属纯文档问题，**不影响任何代码结论**。

### ③ `src/app.ts` 冻结确认 ✅
boottrace 已明确：*`src/app.ts` 当前内容即最终版，不会再改动任何 `src/**`*；
本轮修正**仅动 `.diagnosis/t4-report.md`**。
**verifier 已复核该声明**：`app.ts` 仍为 **224 行**，第 9.2 节当初验证的 7 个锚点行号**复测不变**，
即**本节验证结论现对应冻结终态，不会再被静默失效**。

> ⚠️ **但冻结声明仅覆盖 `app.ts` 及 boottrace 自己的写入范围。**
> verifier 对 **T3 的 11 个文件**（逐字对照基线的核心结论所在）与 T2/T5 文件的验证，
> 其有效性**仍取决于这些文件此后未被修改**。verifier 无法自行监测全仓写入，
> **最终交付前仍需 Lead 统一确认 `src/**` 已全部冻结**（见 9.6 第 1 条）。

## 9.9 本节结论
**`app.ts` 的"覆盖度补修"通过增量复查 ✅**
- 零业务分支影响 ✅　·　符合 Lead 的"不调用停止函数、不加启停"约束 ✅
- 采样设计安全、无泄漏、不影响启动性能 ✅　·　"init 前入队后回灌"路径经独立验证正常 ✅
- **报告行号偏差**：⚠️ 已由 boottrace 修正，verifier **复测确认闭环** → ✅（见 9.8）
- **`src/app.ts` 已冻结**（224 行），本节结论对应冻结终态 ✅（见 9.8 ③）
- **覆盖度计数更新：17/25 → 18/25**（L24 成为"有条件的"落地）
- **verifier 未修改任何 `src/**` 代码**
- 因无法执行命令，**本报告不构成"可编译/可运行"的保证**（详见顶部豁免声明）。

---

# 10. 增量复审（第二轮）：`tsc`/`lint` 门禁引入后的类型与风格提交

> **背景**：用户把本次交付提交为 `caaed5a`，并新增 `npm run tsc` 脚本 —— **该脚本真的报错**，
> 于是产生两个后续提交：`b2b3dab`（fix(types)，5 处类型错误）与 `75ba8d04`（style(lint)，27 error + 1 warning）。
> **`src/**` 的"冻结"因此被打破** —— 且这次打破是**必要的**（门禁查出了真实问题）。
> → **§1.4 与 §2/§9 的结论对该批文件已 stale，本节为最新一轮复审。**

## 10.0 ⚠️ 重要前提：verifier 的 shell 仍不可用（必须如实声明）

**Lead 告知"shell 已恢复，可直接跑 `git diff` / `npm run tsc` / `npm run lint`" —— 该前提对 verifier 不成立。**

verifier 实测（本轮）：
```
pwsh: git log --oneline -6   → Error: sandbox-local windows-acl temp grant materialization failed and its cleanup also failed
pwsh: pwd                    → 同一错误（最小探测，排除命令本身问题）
```
再次尝试官方 ACL 修复脚本 → **再次被自动拒绝** → 按技能硬规则停止（不重试、不绕过、不改 `-AllowRoot`）。

**根因**：verifier 作为 subagent，其**权限范围在会话启动时即被固定**，无法从内部放宽
（系统提示原文："your permission scope was fixed when you were started and cannot be widened from inside this session"）。
→ **用户把 Lead 会话切到 full-access，不会追溯性地解禁 verifier 已启动的会话。**

**因此本轮的方法与证据来源必须严格标注：**
| 项 | 来源 | 标注 |
|---|---|---|
| `git diff b2b3dab 75ba8d04` 原始输出 | **Lead 代跑** | ⚠️ **非 verifier 亲测** |
| `npm run tsc` = 0 / `npm run lint` = 0 | **Lead 代跑** | ⚠️ **非 verifier 亲测** |
| 终态文件内容、类型声明、控制流判定 | **verifier 独立读码** | ✅ 独立验证 |

> **本报告不得出现"verifier 亲测 tsc/lint 双绿"的表述。** 双绿由 Lead 实测，
> verifier **采信但未复现**；verifier 的价值在于**用基线做控制流等价性判断**，这部分是独立的。

## 10.1 复审方法（加性复核，逐层分离）
verifier 手头有两层对照物：
1. **`caaed5a` 之前的 T3 原文**（本会话早期 read 所得，已固化为 §1.2 基线）→ 判断 **T3 是否改了原始业务逻辑**
2. **Lead 提供的 `b2b3dab → 75ba8d04` diff 原文** → 判断 **lint 层是否夹带业务改动**

→ 二者相加即覆盖 `原始 → 75ba8d04` 全链路，可回答"是否只有日志/类型/风格改动"。

## 10.2 ✅ Lead 唯一担心的点：`unref` 运行时守卫**保留**（verifier 独立读码确认）

| 位置 | 终态代码 | 结论 |
|---|---|---|
| `runtimeLog.ts:227` | `if (typeof state.flushTimer?.unref == 'function') state.flushTimer.unref()` | ✅ **守卫保留** |
| `runtimeLog.ts:730` | `if (typeof timer?.unref == 'function') timer.unref()` | ✅ **守卫保留** |

- 两处**唯一改动**是把变量类型 `any` → `ReturnType<typeof setTimeout\|setInterval> \| null`，
  并删掉随之多余的 `as any`。**运行时表达式逐字未变。**
- **Hermes 无 `unref`**：若无条件调用会抛 `TypeError`。守卫在 ⇒ **真机安全** ✅
- `stallWatchdog.ts:224` 的 `setInterval` **本来就没有 `unref`**（对照 §1.2 基线：原 247 行版本同样没有），
  **不是本次删除的** —— verifier 已核对无遗漏。

## 10.3 ✅ `\|\|` → `??` 的 4 处：类型核实为真等价（Lead 点 1，verifier 独立确认）

Lead 判断这些变量"只可能是 `string | null`" —— verifier **独立核实类型声明**：

| 表达式 | 变量声明（verifier 读码确认） | 可否为 `0`/`false` | 结论 |
|---|---|---|---|
| `playerEvent.ts:31` `prevTimeoutId ?? ''` | `playerEvent.ts:14` `let prevTimeoutId: string \| null = null` | ❌ 不可能 | ✅ 等价 |
| `playerEvent.ts:168` 同上 | 同上 | ❌ | ✅ 等价 |
| `core/player/player.ts:525` `playerListId ?? ''` | `types/player.d.ts:53` `playerListId: string \| null` | ❌ | ✅ 等价 |
| `core/player/player.ts:674` 同上 | 同上 | ❌ | ✅ 等价 |

**论证**：`\|\|` 与 `??` 仅在"左侧为 falsy 但非 nullish"时不同。
对 `string | null`，falsy 值只有 `''` 与 `null` —— **两者在 `??` 下也分别得到原值/右侧值，
结果完全相同**。**不存在 `0`/`false` 的可能**（类型层已排除） ⇒ **4 处全部等价** ✅

## 10.4 ✅ 其余改动逐项等价性判定（verifier 独立读终态）

| 改动 | 位置 | verifier 判定 |
|---|---|---|
| 补 `void` | `errorHandle.ts:41` `void flushSyncBestEffort()` | ✅ 等价。调用本身、参数、时机未变；仅标记"有意不等待"。**注**：该函数本就返回 Promise（见 §3 的 MEDIUM-1），故 `void` 不改变任何运行时行为 |
| 补 `void` | `stallWatchdog.ts:199` `void flushSyncBestEffort()` | ✅ 同上 |
| 补 `async` | `log.ts:104` `flushLogsSyncBestEffort`、`Log.tsx:90/121` `.then(async() => readLogFile())` | ✅ 等价。`readLogFile` 本身即 `async` 返回 `Promise<string>`（`runtimeLog.ts:640`），`async` 包装只是 adopt 内层 promise，**resolve 值与链位置不变**（仅多一个微任务 tick） |
| 补花括号 | `log.ts:107` `setLogLevel`、`stallWatchdog.ts` `tick` | ✅ 纯语法 |
| 删未使用导入 | `plugins/player/utils.ts:6` `{ info, warn, error }` → `{ info }` | ✅ 等价。**verifier 已核对 `warn`/`error` 在该文件内确无引用**（grep `as any`/`warn(`/`error(` 均无调用点） |
| 类型断言替换 | `core/music/utils.ts:517, 552` `(… as any).promise` → `….promise` | ✅ **等价且是类型安全改进**。`as any` 是**改动前既有**的（对照 §1.2 基线原文 `:445`/`:480` 均为 `as any`），删除后由真实类型校验，**运行时无任何差异** |
| `Object.keys` 断言 | `stallWatchdog.ts` `Object.keys(detail as Record<string, unknown>)` | ✅ 纯类型层（仅为满足 `no-unsafe-argument`），运行时同 `Object.keys` |
| `eslint-disable` 注释 | `app.ts:64-65` `stopMemorySampling` | ✅ 控制流零改动（句柄保留但暂不调用，符合 Lead 约束） |
| 无关既有修正 | `localFs.ts`、`utils/common.ts` | ✅ 不在本次交付范围；`common.ts` 仅删 1 空行 |

## 10.5 ✅ Lead 点 2：`player.d.ts` 的 `listId` 放宽是否削弱保护？

**结论：不会，且该放宽是修正而非放松。**

| 证据 | 内容 |
|---|---|
| `types/player.d.ts:38` | `PlayMusicInfo.listId: string \| null`（**在 `b2b3dab` 中由 `string` 放宽**） |
| `config/constant.ts:15` | `LIST_IDS.PLAY_LATER: null` ⇒ **该值确实是 `null`** |
| `store/player/state.ts:48` | 初值 `listId: null` |
| `types/player.d.ts:64` | `TempPlayListItem.listId: string \| null`（**同批已为 null 型**） |

**论证**：
1. 原声明 `string` 与**运行时真实值 `null`** 矛盾 —— 这是**类型谎言**，会导致
   `null` 被当作 `string` 传递给下层，**反而掩盖真实的空值处理缺陷**。
2. 放宽为 `string | null` 后，**strict 模式下所有消费点必须显式处理 `null`** ⇒ **保护是增强的**。
3. 底层 `core/player/playInfo.ts` 的函数本就以 `string | null` 接收（Lead 已述，verifier 认可其依据，
   且 `store/player/state.ts:10` `listId: LX.Player.PlayMusicInfo['listId'] | null` 亦印证）。
4. **verifier 另核**：`player.d.ts:78` 的 `SavedPlayInfo.listId: string` **仍是 `string`**（未被放宽）——
   这是**另一个类型**（播放进度持久化记录），与本次放宽无关，**verifier 未发现不一致**。

> **⚠️ 仍需真机/运行确认的边界**：类型放宽**不产生运行时行为变化**，但它**放宽了编译期检查面**。
> 若某处原本依赖"`listId` 必为 string"而**未做 null 判断**，放宽后**编译器不再报错**，
> 缺陷会推迟到运行时暴露。**verifier 无法通过静态手段穷举所有消费点**（无 shell、无法全仓类型追踪）。
> → 建议：**在真机上重点验证"稍后播放"（`PLAY_LATER`，即 `listId === null`）路径**
> 的播放/切歌/进度保存是否正常。这是本次类型改动**唯一需要运行时确认**的点。

## 10.6 ✅ Lead 点 3：加性复核 —— `caaed5a → 75ba8d04` 是否夹带业务逻辑改动？

**结论：✅ 未夹带。** 逐层分离后的判定：

| 层 | 范围 | verifier 判定 |
|---|---|---|
| **T3 业务层**（`caaed5a` 之前 → T3 终态） | 11 个文件 | ✅ §2 已逐字对照基线，**零业务分支改动**（1 处回归已修复） |
| **lint/type 层**（`b2b3dab → 75ba8d04`） | 12 文件 | ✅ §10.3/10.4/10.5 逐项判定**全部等价**（类型/风格/`void`/`??`，无控制流改动） |
| **`b2b3dab` 的 4 个文件** | `timeoutExit.ts`、`hook.ts`、`SourceSelector.tsx`、`player.d.ts` | ✅ 前 3 个**从未在任何 T2/T3/T4/T5 交付范围内**（非本次交付文件）；`player.d.ts` 见 §10.5 |
| **无关既有修正** | `localFs.ts`、`utils/common.ts` | ✅ 不在交付范围 |

**verifier 特别确认（T3 核心结论未被触碰）**：
- ❌ **无任何新增 `try/catch`**（`plugins/player/index.ts` 的 `try {` 仍零命中）
- ❌ **`.finally` 未被改成 `.catch`**（`core/player/player.ts` 的 `.finally(` 仍在）
- ❌ **`await setStop()` 未加超时/未加 catch**
- ❌ **`errorHandle.ts` 的 `Alert.alert` 行为未变**
- ❌ **4 处 `??` 全部等价**（§10.3 类型已核实）
- ✅ **`unref` 运行时守卫保留**（§10.2）

## 10.7 本轮发现的问题

| # | 严重度 | 问题 | 状态 |
|---|---|---|---|
| 7 | 🟢 提示 | verifier 的 shell 在本会话**始终不可用**，且**无法从内部放宽**（权限在启动时固定）。本轮全部 git/tsc/lint 证据为 **Lead 代跑**，verifier 未亲测 | ⚠️ 已如实标注（§10.0），**非代码问题** |
| 8 | 🟡 低-中 | `player.d.ts` 的 `listId` 放宽**不产生运行时变化**，但**扩大了编译期检查面** → 若存在未做 null 判断的消费点，缺陷会推迟到运行时 | ⚠️ **需真机验证 `PLAY_LATER`（`listId === null`）路径**（§10.5） |

**未发现任何新的控制流回归或崩溃风险。**

## 10.8 本轮结论

**✅ 通过。** `b2b3dab` + `75ba8d04` 的改动经 verifier 独立读码复审，**全部为类型/风格层，
未改变任何运行时行为或控制流**：
- `unref` 守卫保留（Lead 唯一担心点）✅ · 4 处 `??` 类型已核实等价 ✅
- `player.d.ts` 放宽是**修正类型谎言**，保护增强而非削弱 ✅（但需真机验 `PLAY_LATER`）
- `caaed5a → 75ba8d04` **未夹带业务逻辑改动** ✅ · T3 核心结论（无 try/catch、`.finally` 保留）**未被触碰** ✅
- **门禁状态**：`npm run tsc` = 0、`npm run lint` = 0 —— **由 Lead 实测，verifier 采信但未复现** ⚠️

**当前有效终态：`75ba8d04`。** §1.4/§2/§9 的结论经本轮复核后**继续成立**。

> **复审轮次记录**（呼应在 §9.6 提出的流程建议）：
> | 轮次 | 触发 | 范围 | 结论 |
> |---|---|---|---|
> | 基准 | — | T2/T3/T4/T5 全部 | ✅ |
> | §9（第 1 轮增量） | `app.ts` 内存采样接入 | `app.ts` | ✅ |
> | **§10（第 2 轮增量）** | `b2b3dab` + `75ba8d04`（tsc/lint 门禁） | 12 文件（T3 中 5 个） | ✅ |
>
> **教训**：`src/**` 的"冻结"在本会话**被打破了两次**，第二次是**必要的**（门禁查出真实类型错误）。
> 这说明"验证后冻结"是**脆弱约定**；更稳妥的做法是**把门禁（tsc/lint）本身作为交付前置**，
> 先让门禁绿，再做人工逻辑复审 —— 否则人工复审会被后续门禁修复反复作废。
