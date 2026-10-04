import {
  assertSafeRelPath,
  buildIndex,
  isAudioFileName,
  type FileIndex,
  type ScanEntry,
} from './diff'
import { appendFile, existsFile, mkdir, readDir, readFileSlice, stat, writeFile } from '@/utils/fs'
import settingState from '@/store/setting/state'

/** 递归扫描的最大深度，防止异常目录结构导致栈溢出 */
const MAX_SCAN_DEPTH = 32

export const getRootPath = () => (settingState.setting['sync.musicFile.root'] ?? '').trim()

const trimEnd = (path: string) => path.replace(/\/+$/, '')

/** 把协议的相对路径还原成本机绝对路径（含安全校验） */
export const toAbsPath = (root: string, relPath: string) => {
  assertSafeRelPath(relPath)
  return `${trimEnd(root)}/${relPath}`
}

const readDirSafe = async(path: string) => {
  try {
    return await readDir(path)
  } catch {
    return []
  }
}

/** 扫描根目录下所有文件夹里的音频文件 */
export const scanEntries = async(root: string): Promise<ScanEntry[]> => {
  const entries: ScanEntry[] = []
  const walk = async(absDir: string, relDir: string, depth: number) => {
    if (depth > MAX_SCAN_DEPTH) return
    const files = await readDirSafe(absDir)
    for (const file of files) {
      const name = file.name
      const relPath = relDir.length ? `${relDir}/${name}` : name
      if (file.isDirectory) {
        await walk(file.path, relPath, depth + 1)
        continue
      }
      if (!file.isFile) continue
      if (!isAudioFileName(name)) continue
      entries.push({ path: relPath, size: file.size ?? 0, mtime: file.lastModified ?? 0 })
    }
  }
  await walk(root, '', 0)
  return entries
}

export const scanIndex = async(root: string): Promise<FileIndex> => {
  if (!root) throw new Error('未设置同步歌曲存放路径')
  return buildIndex(await scanEntries(root))
}

/** 读取一个 base64 分片 */
export const readFileChunk = async(root: string, relPath: string, offset: number, size: number): Promise<LX.Sync.MusicFile.ReadFileResult> => {
  const absPath = toAbsPath(root, relPath)
  const info = await stat(absPath)
  const total = info.size ?? 0
  const start = Math.max(0, Math.min(offset, total))
  const length = Math.max(0, Math.min(size, total - start))
  const data = length > 0 ? await readFileSlice(absPath, start, length) : ''
  return { data, eof: start + length >= total }
}

/** 写入一个 base64 分片：offset 为 0 时重建文件，之后顺序追加 */
export const writeFileChunk = async(root: string, relPath: string, offset: number, data: string, isLast: boolean) => {
  const absPath = toAbsPath(root, relPath)
  if (offset === 0) {
    const index = absPath.lastIndexOf('/')
    if (index > 0) {
      const dir = absPath.substring(0, index)
      if (!await existsFile(dir)) await mkdir(dir)
    }
    await writeFile(absPath, data, 'base64')
    return
  }
  await appendFile(absPath, data, 'base64')
  void isLast
}

export const rootExists = async(root: string) => {
  if (!root) return false
  try {
    const info = await stat(root)
    return info.isDirectory
  } catch {
    return false
  }
}
