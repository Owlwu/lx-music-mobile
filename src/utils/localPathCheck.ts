// 本地可写路径判定（纯函数，无业务副作用）
//
// 规则与一期 `lrcFile.checkLrcMatchablePath` 逐字一致，抽出来给歌词/封面共用：
// - 空值、非 `/` 开头的相对路径 → invalid
// - 带 URI scheme（content://、file:// 等）→ uri
// - 位于 App 缓存/私有目录（含目录自身）→ app_private
// - 其余 → ok
import { privateStorageDirectoryPath, temporaryDirectoryPath } from '@/utils/fs'

export type WritablePathCheckResult = 'ok' | 'invalid' | 'uri' | 'app_private'

export interface WritablePathCheckDirs {
  temporaryDirectoryPath?: string
  privateStorageDirectoryPath?: string
}

const uriSchemeRxp = /^[a-z][a-z0-9+.-]*:/i

const isUnderDir = (filePath: string, dir: string): boolean => {
  if (!dir) return false
  const normalizedDir = dir.endsWith('/') ? dir : `${dir}/`
  return filePath === dir || filePath.startsWith(normalizedDir)
}

/**
 * 只有真实文件系统路径才支持写回同名文件。
 * App 缓存/私有目录里的副本、content:// 等 URI 都无法写回用户目录，直接禁用入口。
 *
 * @param dirs 可显式注入目录（便于测试）；缺省使用当前平台目录常量
 */
export const checkWritableLocalPath = (
  filePath: string | null | undefined,
  dirs: WritablePathCheckDirs = {},
): WritablePathCheckResult => {
  if (!filePath) return 'invalid'
  if (uriSchemeRxp.test(filePath)) return 'uri'
  if (!filePath.startsWith('/')) return 'invalid'
  if (
    isUnderDir(filePath, dirs.temporaryDirectoryPath ?? temporaryDirectoryPath) ||
    isUnderDir(filePath, dirs.privateStorageDirectoryPath ?? privateStorageDirectoryPath)
  ) return 'app_private'
  return 'ok'
}
