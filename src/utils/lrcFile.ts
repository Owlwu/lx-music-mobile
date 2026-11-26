import { existsFile, stat, writeFile } from './fs'
import { checkWritableLocalPath, type WritablePathCheckResult } from './localPathCheck'
import { replaceSidecar, unlinkSidecar, withSidecarWrite } from './sidecarWrite'

export type LrcFileErrorCode =
  | 'permission'
  | 'no_space'
  | 'write_failed'
  | 'delete_failed'
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
  lrcSize?: number
  lrcMtime?: number
}

export interface LrcWriteResult {
  lrcPath: string
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

export const writeLrcFile = async(filePath: string, text: string): Promise<LrcWriteResult> => {
  return withSidecarWrite(getLrcFilePath(filePath), async() => {
    const lrcPath = await findLrcFilePath(filePath)
    const tmpPath = `${lrcPath}.tmp`
    try {
      await unlinkSidecar(tmpPath)
      await writeFile(tmpPath, normalizeLrcText(text))
      await replaceSidecar(tmpPath, lrcPath)
      return { lrcPath }
    } catch (error) {
      throw toLrcFileError(error, 'write_failed')
    } finally {
      await unlinkSidecar(tmpPath).catch(() => {})
    }
  })
}

export const deleteLrcFile = async(filePath: string): Promise<boolean> => {
  if (checkLrcMatchablePath(filePath) !== 'ok' || !(await stat(filePath).catch(() => null))?.isFile) {
    throw new LrcFileError('delete_failed', 'invalid audio file path')
  }
  const lrcPath = getLrcFilePath(filePath)
  return withSidecarWrite(lrcPath, async() => {
    try {
      const deleted = await unlinkSidecar(lrcPath)
      return await unlinkSidecar(lrcPath.slice(0, -4) + '.LRC') || deleted
    } catch (error) {
      throw toLrcFileError(error, 'delete_failed')
    }
  })
}

export const getLrcState = async(filePath: string): Promise<LrcState> => {
  if (checkLrcMatchablePath(filePath) !== 'ok') return { lrcExists: false }
  const lrcPath = await findLrcFilePath(filePath)
  const info = await stat(lrcPath).catch(() => null)
  if (!info?.isFile) return { lrcExists: false }
  return { lrcExists: true, lrcSize: info.size, lrcMtime: info.lastModified }
}
