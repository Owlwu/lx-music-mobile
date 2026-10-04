import {
  assertSafeRelPath,
  buildIndex,
  getRelDir,
  isAudioFileName,
  type FileIndex,
  type ScanEntry,
} from './diff'
import { appendFile, existsFile, mkdir, readDir, readFileSlice, stat, writeFile } from '@/utils/fs'
import settingState from '@/store/setting/state'

/** 递归扫描的最大深度，防止异常目录结构导致栈溢出 */
const MAX_SCAN_DEPTH = 32

export const getRootPath = () => (settingState.setting['sync.musicFile.root'] ?? '').trim()

export const getScope = (): string[] => settingState.setting['sync.musicFile.scope'] ?? []

const trimEnd = (path: string) => path.replace(/\/+$/, '')

/** 把协议的相对路径还原成本机绝对路径（含安全校验） */
export const toAbsPath = (root: string, relPath: string) => {
  assertSafeRelPath(relPath)
  return `${trimEnd(root)}/${relPath}`
}

/** 该文件夹是否可能包含 scope 内的文件 */
const dirAllowed = (relDir: string, scope: readonly string[]) => {
  if (!scope.length) return true
  if (!relDir.length) return true
  return scope.some(folder => relDir === folder || relDir.startsWith(folder + '/') || folder.startsWith(relDir + '/'))
}

const readDirSafe = async(path: string) => {
  try {
    return await readDir(path)
  } catch {
    return []
  }
}

/** 扫描 scope 内所有文件夹下的音频文件 */
export const scanEntries = async(root: string, scope: readonly string[] = getScope()): Promise<ScanEntry[]> => {
  const entries: ScanEntry[] = []
  const walk = async(absDir: string, relDir: string, depth: number) => {
    if (depth > MAX_SCAN_DEPTH) return
    const files = await readDirSafe(absDir)
    for (const file of files) {
      const name = file.name
      const relPath = relDir.length ? `${relDir}/${name}` : name
      if (file.isDirectory) {
        if (!dirAllowed(relPath, scope)) continue
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

export const scanIndex = async(root: string, scope: readonly string[] = getScope()): Promise<FileIndex> => {
  if (!root) throw new Error('未设置同步歌曲存放路径')
  return buildIndex(await scanEntries(root, scope))
}

/** 扫描根目录下的文件夹树，附带音频数量，用于同步范围选择 */
export const scanFolderTree = async(root: string): Promise<LX.Sync.MusicFile.FolderNode[]> => {
  const build = async(absDir: string, relDir: string): Promise<LX.Sync.MusicFile.FolderNode[]> => {
    const files = await readDirSafe(absDir)
    const nodes: LX.Sync.MusicFile.FolderNode[] = []
    for (const file of files) {
      if (!file.isDirectory) continue
      const relPath = relDir.length ? `${relDir}/${file.name}` : file.name
      const children = await build(file.path, relPath)
      const own = (await readDirSafe(file.path)).filter(item => item.isFile && isAudioFileName(item.name)).length
      nodes.push({
        name: file.name,
        path: relPath,
        audioCount: own,
        totalCount: own + children.reduce((sum, child) => sum + child.totalCount, 0),
        children,
      })
    }
    nodes.sort((a, b) => a.name.localeCompare(b.name))
    return nodes
  }
  return build(root, '')
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

export const relDirOf = getRelDir
