import {
  copyFile,
  existsFile,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from './fs'
import { log } from './log'
import { checkWritableLocalPath, type WritablePathCheckResult } from './localPathCheck'

/**
 * 外挂 LRC 文件操作：路径生成、可用性判断、备份/原子写入、回退、状态查询。
 *
 * 规则（设计文档 §4）：
 * - 文件名 = 歌曲路径去掉最后一个扩展名 + `.lrc`，与歌曲同目录
 * - 已存在 `.lrc` 且无 `.lrc.bak` 时先备份（只备份一次）
 * - 先写 `.lrc.tmp` 再重命名，失败时清理临时文件并尽量恢复原文件
 * - 回退：先把 `.lrc.bak` 内容写回 `.lrc`，成功后再删除备份（失败不丢数据、可重试）
 * - 绝不修改音频文件
 */

export type LrcFileErrorCode =
  | 'permission'
  | 'no_space'
  | 'backup_failed'
  | 'write_failed'
  | 'rename_failed'
  | 'restore_failed'
  | 'unknown'

export class LrcFileError extends Error {
  code: LrcFileErrorCode

  constructor(code: LrcFileErrorCode, message: string) {
    super(message)
    this.name = 'LrcFileError'
    this.code = code
  }
}

export type LrcPathCheckResult = WritablePathCheckResult

export interface LrcState {
  lrcExists: boolean
  backupExists: boolean
  lrcSize?: number
  lrcMtime?: number
}

export interface LrcWriteResult {
  lrcPath: string
  backupCreated: boolean
}

export interface LrcRollbackResult {
  restored: boolean
}

/**
 * 只有真实文件系统路径才支持写同名 .lrc。
 * App 缓存/私有目录里的副本、content:// 等 URI 都无法写回用户目录，直接禁用入口。
 */
export const checkLrcMatchablePath = (filePath?: string | null): LrcPathCheckResult => {
  return checkWritableLocalPath(filePath)
}

/**
 * 歌曲文件对应的 .lrc 路径（与歌曲同名同目录）
 */
export const getLrcFilePath = (filePath: string): string => {
  const dirIndex = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const dotIndex = filePath.lastIndexOf('.')
  if (dotIndex <= dirIndex) return `${filePath}.lrc`
  return `${filePath.substring(0, dotIndex)}.lrc`
}

/**
 * 备份文件路径（.lrc.bak）
 */
export const getLrcBackupPath = (filePath: string): string => `${getLrcFilePath(filePath)}.bak`

const basename = (filePath: string): string => {
  const dirIndex = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return filePath.substring(dirIndex + 1)
}

/**
 * 查找已存在的 LRC 文件：优先小写 .lrc，其次兼容 .LRC；
 * 都不存在时返回小写 .lrc（写入时新建）。
 */
export const findLrcFilePath = async(filePath: string): Promise<string> => {
  const lrcPath = getLrcFilePath(filePath)
  if (await existsFile(lrcPath)) return lrcPath
  const upperPath = `${lrcPath.substring(0, lrcPath.length - 4)}.LRC`
  if (await existsFile(upperPath)) return upperPath
  return lrcPath
}

/**
 * 统一 LRC 文本：去 BOM、统一 \n、结尾补换行
 */
export const normalizeLrcText = (text: string): string => {
  let result = text.replace(/\uFEFF/g, '').replace(/\r\n?/g, '\n')
  if (result && !result.endsWith('\n')) result += '\n'
  return result
}

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message
  return String(error)
}

const classifyFileError = (error: unknown): LrcFileErrorCode => {
  const message = getErrorMessage(error)
  if (/EACCES|EPERM|permission|read-only|readonly|Read-only/i.test(message)) return 'permission'
  if (/ENOSPC|no space|disk full|space left|空间不足/i.test(message)) return 'no_space'
  return 'unknown'
}

const toLrcFileError = (error: unknown, fallback: LrcFileErrorCode): LrcFileError => {
  if (error instanceof LrcFileError) return error
  const code = classifyFileError(error)
  return new LrcFileError(code === 'unknown' ? fallback : code, getErrorMessage(error))
}

/**
 * 写入 LRC 文件（备份 -> 临时文件 -> 重命名）
 * @returns 写入的 lrc 路径与是否本次新建了备份
 */
export const writeLrcFile = async(filePath: string, text: string): Promise<LrcWriteResult> => {
  const lrcPath = getLrcFilePath(filePath)
  const backupPath = getLrcBackupPath(filePath)
  const tmpPath = `${lrcPath}.tmp`
  const lrcName = basename(lrcPath)
  const backupName = basename(backupPath)
  const content = normalizeLrcText(text)
  let backupCreated = false

  try {
    const lrcExisting = await existsFile(lrcPath)
    if (lrcExisting) {
      const backupExisting = await existsFile(backupPath)
      // 仅首次备份：已有 .bak 时保留原始备份，直接覆盖 .lrc
      if (!backupExisting) {
        const renamed = await rename(lrcPath, backupName)
        if (!renamed) throw new LrcFileError('backup_failed', `backup lrc file failed: ${lrcPath}`)
        backupCreated = true
      }
    }

    await writeFile(tmpPath, content)

    let renamed = await rename(tmpPath, lrcName)
    if (!renamed && await existsFile(lrcPath)) {
      // 部分文件系统不允许 rename 覆盖已存在文件：先删除旧文件再重试一次
      await unlink(lrcPath).catch(() => {})
      if (!(await existsFile(lrcPath))) renamed = await rename(tmpPath, lrcName)
    }
    if (!renamed) throw new LrcFileError('rename_failed', `rename lrc temp file failed: ${tmpPath}`)

    return { lrcPath, backupCreated }
  } catch (error) {
    await unlink(tmpPath).catch(() => {})
    if (backupCreated) {
      // 本次刚备份且尚未写入成功：把备份改回原文件
      const restored = await rename(backupPath, lrcName).catch(() => false)
      if (!restored) log.warn(`restore lrc backup failed: ${backupPath}`)
    } else if (!(await existsFile(lrcPath).catch(() => false)) && await existsFile(backupPath).catch(() => false)) {
      // 覆盖已有备份的场景下旧 .lrc 已被删除：从备份复制回来（保留备份本身）
      await copyFile(backupPath, lrcPath).catch(() => {})
    }
    throw toLrcFileError(error, 'write_failed')
  }
}

/**
 * 回退：先把 .lrc.bak 的内容写回 .lrc，成功后再删除备份。
 * 失败时保留当前 .lrc 与 .lrc.bak（可重试），不会先删除当前歌词。
 */
export const rollbackLrcFile = async(filePath: string): Promise<LrcRollbackResult> => {
  const lrcPath = getLrcFilePath(filePath)
  const backupPath = getLrcBackupPath(filePath)
  const lrcName = basename(lrcPath)
  const tmpPath = `${lrcPath}.restore.tmp`

  if (!(await existsFile(backupPath))) return { restored: false }

  try {
    // 以 base64 复制原始字节，避免二次解码改变原备份编码
    const backupBase64 = await readFile(backupPath, 'base64')
    try {
      await writeFile(tmpPath, backupBase64, 'base64')
      let restored = await rename(tmpPath, lrcName)
      if (!restored) {
        // 目标已存在且平台不允许 rename 覆盖：退回复制覆盖（备份仍在，失败可重试）
        await copyFile(tmpPath, lrcPath)
        restored = await existsFile(lrcPath)
      }
      if (!restored) throw new LrcFileError('restore_failed', `restore lrc backup failed: ${backupPath}`)
    } finally {
      await unlink(tmpPath).catch(() => {})
    }

    // .lrc 已写回成功后再删除备份；删除失败时保留备份，不影响已恢复的歌词
    await unlink(backupPath).catch(() => {})
    if (await existsFile(backupPath)) log.warn(`remove lrc backup failed: ${backupPath}`)
    return { restored: true }
  } catch (error) {
    throw toLrcFileError(error, 'restore_failed')
  }
}

/**
 * 查询 .lrc / .lrc.bak 状态，用于播放页按钮可用性
 */
export const getLrcState = async(filePath: string): Promise<LrcState> => {
  const lrcPath = getLrcFilePath(filePath)
  const backupPath = getLrcBackupPath(filePath)
  const [lrcExists, backupExists] = await Promise.all([
    existsFile(lrcPath).catch(() => false),
    existsFile(backupPath).catch(() => false),
  ])
  const state: LrcState = { lrcExists, backupExists }
  if (lrcExists) {
    try {
      const info = await stat(lrcPath)
      state.lrcSize = info.size
      state.lrcMtime = info.lastModified
    } catch {}
  }
  return state
}
