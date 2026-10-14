# T5 报告：设置页接入运行时日志查看 / 导出

**任务**：task-5（owner: `logui`）
**状态**：代码完成（含 verifier 发现缺陷的修复，见 §8）；**tsc / eslint 未能运行**（见 §5，会话级沙箱故障，非代码问题）
**工作目录**：`E:\WorkSpace\LXMusic\lx-music-mobile`

---

## 1. 改动文件清单

| 文件 | 改动性质 |
|---|---|
| `src/screens/Home/Views/Setting/settings/Other/Log.tsx` | 改写（在保留全部既有功能的前提下扩展 UI） |
| `src/lang/zh-cn.json` | 仅新增 11 个 key |
| `src/lang/zh-tw.json` | 仅新增 11 个同名 key |
| `src/lang/en-us.json` | 仅新增 11 个同名 key |
| `.diagnosis/t5-report.md` | 本报告 |

**未改动**（遵守写入范围）：`src/utils/log.ts`（T2 已提供 `getLogPath`/`getDiagnostics`/`flushLogs` 透传，无需再动）、`src/utils/runtimeLog.ts`、`src/utils/stallWatchdog.ts`、`src/app.ts`、`src/plugins/**`、`src/core/**`、`src/navigation/**`。
**未新增任何依赖**：剪贴板复用工程已有的 `@react-native-clipboard/clipboard`（经 `@/utils/tools` 的 `clipboardWriteText`），分享复用工程已有的 `@/utils/nativeModules/utils` 的 `shareText`。

---

## 2. UI 入口位置（用户怎么走到）

首页 → 侧边栏/底部 **设置** → **其他设置**（`Section title={t('setting_other')}`）→ 最后一个子区块 **“错误日志（运行发生异常时的日志）”**。

> 结构链：`Setting/index.tsx` → `Setting/settings/Other/index.tsx`（`Section` 下依次是 `ResourceCache` / `MetaCache` / `DislikeList` / **`Log`**）→ `settings/Other/Log.tsx`。
> 我**没有**改 `Other/index.tsx`：本任务是在既有的 Log 区块内扩展，无需新增导航子项。

### 页面上的按钮（共 5 个 + 2 个既有复选框）

| 按钮 | i18n key | 行为 |
|---|---|---|
| 查看日志 | `setting_other_log_btn_show`（既有） | **既有功能，未改**：读 `error.log` 全文弹层展示 |
| 查看运行时日志 | `setting_other_log_btn_show_runtime`（新增） | 先 `flushLogs()` 落盘 → `readLogFile()` 读 `runtime.log` 全文（含 `.1`/`.2` 备份，最旧在前）→ 弹层展示 |
| 分享日志 | `setting_other_log_btn_share`（新增） | `flushLogs()` → `readLogFile()` → 走系统分享 `shareText(...)`，正文含**文件路径 + 日志全文** |
| 复制诊断信息 | `setting_other_log_btn_copy_diagnostics`（新增） | `flushLogs()` → `getDiagnostics()`（路径/等级/缓冲条数/待写条数/近似大小/写失败次数 + 最近日志）+ `error.log` 路径 → 复制到剪贴板 |
| 清空日志文件 | `setting_other_log_btn_clean_file`（新增） | **破坏性**：`confirmDialog` 二次确认后 `clearLogFiles()` 删除 `runtime.log` 及全部备份 |

### 弹层内的「清空」按钮（`confirmText` = `setting_other_log_btn_clean`）

这是 §8 修复的核心。**该按钮清掉的永远是当前弹层里正在展示的那份日志**，由 `isShowingRuntimeLog` 决定路由：

| 弹层在展示 | `isShowingRuntimeLog` | 「清空」实际调用 | 效果 |
|---|---|---|---|
| `error.log`（点“查看日志”） | `false` | `handleCleanLog()` → `clearLogs()` | 删 `error.log` 及其备份 |
| `runtime.log`（点“查看运行时日志”） | `true` | 二次确认 → `clearLogFiles()` | 删 `runtime.log` 及全部备份 |

> `showConfirm` 仍为 `!!logText`（保持既有行为：日志非空才显示“清空”），但**动作已与展示内容绑定**，不再出现“看着 runtime.log 却把 error.log 删了”。


另外，页面顶部显示两行**实际磁盘路径**（供用户用文件管理器取）：

```
日志文件路径：<CacheDir>/error.log
运行时日志路径：<CacheDir>/runtime.log      ← 可长按选中复制
```

- 路径经 `getLogPath()`（→ `legacyLogPath()`）与 `runtimeLogPath()` 惰性解析。
- **空值兜底**：两者都可能返回 `''`（平台目录极早期未就绪），此时显示 `setting_other_log_path_unavailable`（“暂不可用”），绝不显示空白路径。
- 运行时日志路径一行加了 `selectable`，用户可直接长按复制路径。

---

## 3. 日志文件实际磁盘路径（用户取日志步骤）

两者都在 `temporaryDirectoryPath`（= `react-native-file-system` 的 `Dirs.CacheDir`，Android 上即应用私有 `cache` 目录）：

- 运行时日志：`<CacheDir>/runtime.log`，轮转备份 `<CacheDir>/runtime.log.1`、`<CacheDir>/runtime.log.2`
- 旧错误日志：`<CacheDir>/error.log`

**普通用户（推荐，无需文件管理器）**
1. 设置 → 其他设置 → 错误日志 区。
2. 点 **“查看运行时日志”**，长按选中全文 → 复制；或点 **“复制诊断信息”** 一键复制（含路径与状态）。
3. 或点 **“分享日志”** 直接分享到微信/GitHub App/备忘录。

**进阶用户（文件管理器取原始文件）**
1. 按页面显示的 `运行时日志路径` 定位文件。
2. 该路径在 Android 应用私有 `cache` 目录下，未 root 的设备第三方文件管理器通常**无法直接浏览**；建议优先用上面的“分享日志”导出，或用 adb：
   `adb shell run-as <packageName> cat cache/runtime.log`

---

## 4. 与既有行为的一致性（“不改动现有功能”核对）

- `getLogs()` / `clearLogs()` 的调用与 `'----lx log----'` 切分逻辑**原样保留**（我把切分抽成 `splitLegacyLog()` 常量函数，正则一字未改）。
- 既有弹层 `ConfirmAlert` 的 props（`cancelText`/`confirmText`/`onConfirm`/`showConfirm`/`reverseBtn`/`onStartShouldSetResponder`）与“日志为空”提示**完全未改**。
- 两个既有复选框（同步日志 / 自定义源 API 日志）逻辑未改。
- **仅新增**：两行路径文本、4 个新按钮、`refreshPaths`/`handleShowRuntimeLog`/`handleCopyDiagnostics`/`handleShareLog`/`handleCleanLogFiles`。
- 样式沿用 `createStyle()`（`@/utils/tools`），2 空格 / 单引号 / 无分号，与同目录 `ResourceCache.tsx`、`MetaCache.tsx` 一致（`gap` + `flexWrap` 抄自 `MetaCache.tsx`）。

---

## 5. 验收命令执行情况（如实记录）

```
npx tsc --noEmit 2>&1 | Select-Object -First 60
npx eslint src/screens/Home/Views/Setting/settings/Other/Log.tsx
```

**结果：两条命令均未能运行。** `pwsh` 工具在本会话中任何调用都失败，包括 `Get-Location`：

```
Error: sandbox-local windows-acl temp grant materialization failed and its cleanup also failed
```

原因已由 lead 定位并裁定：`E:\WorkSpace` 与 `E:\` 的 owner 属另一 SID 且缺 `WRITE_DAC`/`WRITE_OWNER`，沙箱无法在祖先落地临时授权；官方修复脚本 VERDICT=`NOT_THIS_CLASS`，修复无效。**这是会话级环境故障，与本次改动无关。** 按 lead 裁决，本任务 tsc/eslint 验收项豁免。

> ⚠️ 因此本报告**不声称** tsc/eslint 通过。

---

## 6. 替代性逐行自查（已执行的检查点）

### 6.1 import 存在性与签名（逐个 grep 核对，非凭记忆）

| 导入 | 来源 | 核对结果 |
|---|---|---|
| `getLogs` | `@/utils/log` | `log.ts:61` `async(): Promise<string>` ✅ 未传参、已 `void` |
| `clearLogs` | `@/utils/log` | `log.ts:75` `async(): Promise<void>` ✅ 已 `void` |
| `getLogPath` | `@/utils/log` | `log.ts:32` `(): string` ✅ 同步 |
| `flushLogs` | `@/utils/log` | `log.ts:101` `async(): Promise<void>` ✅ 已 `void` |
| `getDiagnostics` | `@/utils/log` | `log.ts:98` `(): string` ✅ 同步 |
| `clearLogFiles` | `@/utils/runtimeLog` | `runtimeLog.ts:621` `async(): Promise<void>` ✅ 已 `void` |
| `readLogFile` | `@/utils/runtimeLog` | `runtimeLog.ts:640` `async(): Promise<string>` ✅ 在 `.then` 内 |
| `runtimeLogPath` | `@/utils/runtimeLog` | `runtimeLog.ts:207` `(): string` ✅ 同步 |
| `createStyle`/`toast`/`clipboardWriteText`/`confirmDialog` | `@/utils/tools` | `tools.ts:516/107/239/186` ✅ |
| `shareText` | `@/utils/nativeModules/utils` | `utils.ts:47` `(shareTitle, title, text): Promise<void>` ✅ 三参顺序正确 |

**async 漏 await/void 专项**：`clearLogFiles()`、`flushLogs()`、`readLogFile()`、`getLogs()`、`clearLogs()`、`shareText()`、`confirmDialog()` 全部 Promise，均已 `void` 或链式 `.then()`，**无未处理 Promise**。同步函数（`getLogPath`/`runtimeLogPath`/`getDiagnostics`/`clipboardWriteText`）未误加 `await`。

### 6.2 组件 props 与 ref 类型

- `CheckBoxItem`：`props: CheckBoxProps` → `{ check: boolean, label?: string, onChange: (check: boolean) => void }`（`CheckBox/index.tsx:11-24`）。我的用法 `check={boolean}` / `label={string}` / `onChange={(enable: boolean) => void}` ✅ 与**改动前完全一致**。
- `Button`（`Setting/components/Button.tsx`）：`BtnProps = BtnProps(PressableProps) & { children: React.ReactNode }`，透传 `disabled`/`onPress`。我用 `<Button onPress={...}>`、`<Button disabled={...} onPress={...}>` ✅。
- `ConfirmAlert`：`useRef<ConfirmAlertType>(null)`，`ConfirmAlertType = { setVisible: (visible: boolean) => void }`（`ConfirmAlert.tsx:71-73`）。我用 `alertRef.current?.setVisible(true)` ✅（可选链，符合既有写法）。
- `Text`：支持 `size?: number`、`selectable`（透传 `_TextProps`）✅。
- `SubTitle`：`{ title: string, children: React.ReactNode | React.ReactNode[] }` ✅。
- `View` 来自 `react-native` ✅；`onStartShouldSetResponder={() => true}` 保持原样 ✅。

### 6.3 i18n key 三语齐全性

复用既有 key（8 个，零改动、零新增）：`copy_name_tip`、`setting_other_log`、`setting_other_log_btn_clean`、`setting_other_log_btn_hide`、`setting_other_log_btn_show`、`setting_other_log_sync_log`、`setting_other_log_tip_clean_success`、`setting_other_log_tip_null`、`setting_other_log_user_api_log`。

新增 key（10 个 × 3 语言 = 30 处，grep 实测 30 命中，无缺失）：

| key | zh-cn | zh-tw | en-us |
|---|---|---|---|
| `setting_other_log_btn_clean_file` | 清空日志文件 | 清空日誌檔案 | Clear log files |
| `setting_other_log_btn_copy_diagnostics` | 复制诊断信息 | 複製診斷資訊 | Copy diagnostics |
| `setting_other_log_btn_share` | 分享日志 | 分享日誌 | Share log |
| `setting_other_log_btn_show_runtime` | 查看运行时日志 | 查看執行時日誌 | View runtime log |
| `setting_other_log_clean_file_confirm` | 将删除日志文件及其备份，确定继续吗？ | 將刪除日誌檔案及其備份，確定要繼續嗎？ | This will delete the log files and their backups. Continue? |
| `setting_other_log_path` | 日志文件路径： | 日誌檔案路徑： | Log file path: |
| `setting_other_log_path_unavailable` | 暂不可用 | 暫不可用 | Not available |
| `setting_other_log_runtime_path` | 运行时日志路径： | 執行時日誌路徑： | Runtime log path: |
| `setting_other_log_share_desc` | 应用日志（请连同此文件一起提交到 GitHub Issue） | 應用日誌（請連同此檔案一起提交到 GitHub Issue） | App log (please attach it when submitting a GitHub issue) |
| `setting_other_log_share_title` | LX Music 日志 | LX Music 日誌 | LX Music log |

**关键类型正确性**：`src/lang/index.ts:5` 的 `Message` 类型由 `zh-cn.json` 等的 **key 集合**推导，因此 `t('不存在的key')` 会是 TS 类型错误。已逐个 key 用 grep 在**三个** JSON 中确认存在 —— 这是 tsc 不可用时对 i18n 类型安全最直接的替代验证。

**JSON 结构安全性**：所有新增均为 `"key": "value",` 形式的**行插入**，插入点紧跟既有 `setting_other_log_btn_show` 之后；既有 key 的名称、值、顺序、末尾逗号结构均未触碰（前后行已 read 核对：zh-cn 由 561 → 571 行，净增 10 行 = 新增 key 数，说明无删除）。

### 6.4 API 语义正确性（对照 T2 冻结文档）

- `readLogFile()` **内部会先 `flush()`**（`runtimeLog.ts:644` 注释 + 实现），所以“查看运行时日志/分享”其实已隐含落盘；我额外显式 `flushLogs()` 是冗余但无害的保险，且能覆盖 `runtimeLog` 未 init 的场景。
- `getSnapshot()` 失败返回 `''`、`getEntries()` 失败返回 `[]`（`runtimeLog.ts:575-587, 561-567`）—— 我未直接调用它们（改用 `readLogFile`/`getDiagnostics`），但知道其在异常态下不会抛错。
- **未调用 `startMemorySampling()`**（按 lead 要求，设置页不管理该定时器，避免永久 `setInterval`）。
- `clearLogFiles()` = 清内存 + 删 `runtime.log` 及全部备份（`runtimeLog.ts:621-637`）；我把它放在 `confirmDialog` 之后，符合“破坏性操作需确认”。
- `getLogPath()` 为**同步**返回（`log.ts:32` → `legacyLogPath()`），我未误当 Promise 处理 ✅。

### 6.5 卸载安全

沿用既有 `isUnmountedRef` 模式：所有异步回调（`.then`/`.finally`）在 `setState` 前都先 `if (isUnmountedRef.current) return`，覆盖 `getErrorLog`、`handleShowRuntimeLog`、`handleCopyDiagnostics`、`handleShareLog`、`handleCleanLogFiles` ✅。

### 6.6 未做的检查（诚实声明）

- 未运行 `tsc` / `eslint`（环境故障）。
- 未在真机/模拟器运行，UI 为静态代码审阅；按钮排布（两行 `flexWrap` + `gap`）未做视觉验证。
- 未验证 `shareText` 在无分享目标时的原生行为（沿用工程既有分享路径，风险与现状一致）。

---

## 7. 给 verifier / lead 的提示

1. 请把**本文件**与 `runtimeLog.ts` 的 **最终版本**（logcore 修完 3 个缺陷后）一起复核 —— 我读的是 revision 3 即 completed 后的版本。
2. 若日后能跑 shell，本任务需补跑：
   `npx tsc --noEmit` 与 `npx eslint src/screens/Home/Views/Setting/settings/Other/Log.tsx`。
3. 唯一需要留意的风格点：`styles.btn` 我加了 `flexWrap: 'wrap'` 与 `gap: 5`，其中 `gap` 抄自同目录 `MetaCache.tsx:79`，属工程内既有用法（RN 版本需支持 `gap`；`MetaCache.tsx` 已在用，故安全）。

---

## 8. 【修复】verifier 发现的缺陷：弹层「清空」删错日志

### 8.1 缺陷（已确认属实，我引入的）

初版中同一个 `logText` state 被三种内容复用，但弹层的确认按钮恒定绑到 `handleCleanLog`（只清 `error.log`）：

- `openLogModal()` → `setLogText(splitLegacyLog(getLogs()))` = **error.log** 内容
- `handleShowRuntimeLog()` → `setLogText(readLogFile())` = **runtime.log** 内容 ← 复用同一 state
- `onConfirm={handleCleanLog}` → `clearLogs()` → **只删 error.log**

**用户实际遭遇**：点“查看运行时日志”后，弹层底部出现“清空”按钮，用户合理理解为“清空正在看的这份”；点下去却删掉了 **error.log 及其备份**，而 runtime.log 一字未删；同时 `getErrorLog()` 把 `logText` 覆盖成 error.log 内容，用户**误以为 runtime.log 已清空**。后果是**两份排查证据同时丢失** —— 与本任务目标（让用户拿得到日志）完全相反。

### 8.2 采用的修复方案（选“方案二：按来源路由清空动作”，不选“隐藏按钮”）

我选择**给两份日志各自绑定匹配的清空动作**，而非 lead 给的方案一（`showConfirm={!!logText && !isShowingRuntimeLog}` 让按钮在展示 runtime.log 时消失）。**理由**：

1. **方案一只能单向保证不变量**：它阻止了“看 runtime.log → 删 error.log”，但代价是用户**在 runtime.log 视图下彻底无法清空 runtime.log**（按钮直接消失），只能退出去点独立按钮 —— 而 runtime.log 恰是本次新增的、体积会增长的那份日志，实际最需要清空入口。
2. **本任务要求的不变量是双向的**：“用户点清空时，被清掉的一定是当前弹窗里展示的那份”。方案二在两个方向上同时成立（展示 error.log → 清 error.log；展示 runtime.log → 清 runtime.log），方案一只在其中一个方向成立。
3. **复用既有能力、改动同样小**：`clearLogFiles()`（T2 已实现）与 `handleCleanLogFiles()` 的二次确认逻辑都已有，只是把路由接上。
4. 破坏性操作保留二次确认（`confirmDialog`），符合 lead 原要求。

### 8.3 具体改动（涉及 state 与行号，行号为修复后终态）

| 位置 | 改动 |
|---|---|
| `:30-32` | **新增 state** `const [isShowingRuntimeLog, setIsShowingRuntimeLog] = useState(false)`，注释说明语义（false=error.log，true=runtime.log） |
| `:51-56` `openLogModal` | 进入前 `setIsShowingRuntimeLog(false)` —— 标记当前展示 error.log |
| `:66-84` `handleCleanShowingLog`（**新增**） | 按 `isShowingRuntimeLog` 路由：false → `handleCleanLog()`（`clearLogs()` 删 error.log）；true → `confirmDialog` 二次确认 → `clearLogFiles()` 删 runtime.log 及备份 |
| `:192` `ConfirmAlert` | `onConfirm={handleCleanLog}` → **`onConfirm={handleCleanShowingLog}`**（唯一改动的一行弹层 props） |
| `:92` `handleShowRuntimeLog` | 成功回调里 `setIsShowingRuntimeLog(true)` —— 标记当前展示 runtime.log |
| `:137-141` `handleCleanLogFiles` | 独立按钮清空 runtime.log 后，**仅当弹层正展示它就** `setLogText('')`（避免误清 error.log 的展示内容） |
| `:58-64` `handleCleanLog` | 补上卸载守卫（原缺），并把 `if (isUnmountedRef.current) return` 提到 `toast` 之前 |

**未改动**：`showConfirm={!!logText}` 保持不变（维持既有语义）；`splitLegacyLog` 正则一字未动；`ConfirmAlert` 其余 props 未动。

### 8.4 顺手修的 unhandled rejection（lead 指出的低优先级项）

`:96-100` 给 `handleShowRuntimeLog` 的 promise 链补了 `.catch`：

```ts
}).catch(() => {
  if (isUnmountedRef.current) return
  toast(t('setting_other_log_tip_read_failed'))
}).finally(() => { ... })
```

- 修复前：`readLogFile()` reject 会成为 unhandled rejection，且**弹层永不打开、按钮被 `finally` 复位** → 用户“点了没反应”，无从判断。
- 修复后：给出明确的失败 toast，`finally` 仍负责复位 `isFetchingRuntimeLog`，按钮不会卡死。
- 新增 i18n key `setting_other_log_tip_read_failed`（**三语齐全**，按字母序插在 `setting_other_log_tip_null` 之后、`setting_other_log_user_api_log` 之前）：
  - zh-cn：读取日志失败，请稍后重试
  - zh-tw：讀取日誌失敗，請稍後重試
  - en-us：Failed to read the log, please try again later

### 8.5 修复后的不变量验证（逐路径推演）

| 路径 | `isShowingRuntimeLog` | 点「清空」→ 实际删除 | 弹层内容 | 一致？ |
|---|---|---|---|---|
| 点“查看日志”（error.log） | `false` | `clearLogs()` → error.log | 刷新为清空后状态 | ✅ |
| 点“查看运行时日志”（runtime.log） | `true` | `confirmDialog` → `clearLogFiles()` → runtime.log + `.1`/`.2` | 置空 | ✅ |
| 独立按钮“清空日志文件” | 任意 | runtime.log + 备份（二次确认） | 仅当正展示 runtime.log 时置空 | ✅ |
| 取消二次确认 | `true` | **不删除任何东西** | 保持原样 | ✅ |

**新增 key 计数更新**：本次修复新增 1 个 key（`setting_other_log_tip_read_failed`）× 3 语言 = 3 处；累计新增 11 key × 3 = 33 处，已 grep 实测齐全。

### 8.6 修复后的自查补充

- 新增代码全部为**同步 state 赋值 + 既有 async 调用**，无新增 import、无新依赖。
- `handleCleanShowingLog` 与 `handleCleanLog` 的定义顺序已调整为：先 `handleCleanLog`（`:58`）后 `handleCleanShowingLog`（`:68`），避免依赖函数提升的阅读负担（虽然运行时均无问题）。
- `handleCleanShowingLog` 两条分支都在 `setState` 前做了 `isUnmountedRef` 守卫 ✅。
- **tsc / eslint 仍未运行**（同一环境故障），未声称通过。

