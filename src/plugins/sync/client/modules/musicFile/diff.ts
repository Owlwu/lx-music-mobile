/**
 * 本地音乐文件同步的纯逻辑（无任何依赖，PC 与 Android 两端保持完全一致的副本）
 *
 * 契约见 `lx-music-desktop/doc/music-file-sync/本地音乐文件同步-设计.md`。
 * 该文件不允许 import 任何模块，以便直接用 node 运行测试（见 /tests）。
 */

/** 参与同步的音频扩展名（与 App 支持的播放格式保持一致） */
export const AUDIO_EXTENSIONS = ['mp3', 'flac', 'ogg', 'oga', 'wav', 'm4a'] as const

/** 单次 RPC 传输的原始字节数（base64 后约 256KB） */
export const MUSIC_FILE_CHUNK_SIZE = 192 * 1024

export type FileGroupKey = 'remoteAdded' | 'localAdded'

export const FILE_GROUP_KEYS: FileGroupKey[] = ['remoteAdded', 'localAdded']

export interface FileItem {
  /** 相对同步根目录的路径，使用 `/` 分隔 */
  path: string
  size: number
  mtime: number
}

export interface FileIndex {
  /** 索引中出现过的文件夹相对路径（去重、字典序） */
  folders: string[]
  /** 索引中的音频文件（按 path 字典序） */
  files: FileItem[]
}

export interface PlanItem {
  group: FileGroupKey
  path: string
  localSize: number | null
  remoteSize: number | null
  defaultChecked: boolean
  defaultDirection: TransferDirection
}

export type TransferDirection = 'push' | 'pull'

export type PlanGroups = Record<FileGroupKey, PlanItem[]>

export interface ScanEntry {
  /** 相对路径 */
  path: string
  size: number
  mtime: number
}

export type TransferAction =
  | { kind: 'download', path: string, size: number }
  | { kind: 'upload', path: string, size: number }

export const getExt = (name: string) => {
  const index = name.lastIndexOf('.')
  return index > 0 && index < name.length - 1 ? name.substring(index + 1).toLowerCase() : ''
}

export const isAudioFileName = (name: string) => (AUDIO_EXTENSIONS as readonly string[]).includes(getExt(name))

/** 统一分隔符并去掉多余的前导 `./` */
export const normalizeRelPath = (relPath: string) => relPath.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/{2,}/g, '/')

/**
 * 相对路径安全校验：拒绝绝对路径、盘符、反斜杠与 `..` 段，
 * 防止对端通过协议参数写到同步根目录之外。
 */
export const isSafeRelPath = (relPath: string) => {
  if (typeof relPath !== 'string' || !relPath.length) return false
  if (relPath.includes('\\')) return false
  if (relPath.startsWith('/')) return false
  if (/^[A-Za-z]:/.test(relPath)) return false
  if (relPath.endsWith('/')) return false
  for (const segment of relPath.split('/')) {
    if (!segment.length || segment === '.' || segment === '..') return false
  }
  return true
}

export const assertSafeRelPath = (relPath: string) => {
  if (!isSafeRelPath(relPath)) throw new Error(`Invalid relative path: ${relPath}`)
  return relPath
}

/** 取相对路径所在的文件夹（根目录下为 ''） */
export const getRelDir = (relPath: string) => {
  const index = relPath.lastIndexOf('/')
  return index === -1 ? '' : relPath.substring(0, index)
}

/** scope 为空表示根目录全部；否则文件所在文件夹必须等于或位于某个已选文件夹之下 */
export const isPathInScope = (relPath: string, scope: readonly string[]) => {
  if (!scope.length) return true
  const dir = getRelDir(relPath)
  return scope.some(folder => dir === folder || dir.startsWith(folder + '/'))
}

/** 勾选某文件夹时，其所有子文件夹也一并纳入（用于 UI 树与结果展示） */
export const normalizeScope = (scope: readonly string[]) => {
  const list = Array.from(new Set(scope.map(normalizeRelPath).filter(folder => folder.length && isSafeRelPath(folder))))
  const result: string[] = []
  for (const folder of list.sort()) {
    if (result.some(parent => folder === parent || folder.startsWith(parent + '/'))) continue
    result.push(folder)
  }
  return result
}

/**
 * 由扫描结果构建索引：只保留音频文件。
 * 传入的 `entries` 是目录下所有文件的原始列表。
 */
export const buildIndex = (entries: readonly ScanEntry[]): FileIndex => {
  const folderSet = new Set<string>()
  const files: FileItem[] = []
  for (const entry of entries) {
    if (!isAudioFileName(entry.path)) continue
    files.push({
      path: entry.path,
      size: entry.size,
      mtime: entry.mtime,
    })
    const dir = getRelDir(entry.path)
    if (!dir.length) continue
    for (const folder of [dir, ...parentsOf(dir)]) folderSet.add(folder)
  }

  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  return { folders: Array.from(folderSet).sort(), files }
}

const indexMap = (index: FileIndex) => {
  const map = new Map<string, FileItem>()
  for (const file of index.files) map.set(file.path, file)
  return map
}

const emptyGroups = (): PlanGroups => ({
  remoteAdded: [],
  localAdded: [],
})

/**
 * 按契约 1.2 分类变更。size 相同即视为内容一致（mtime 不参与判断）。
 * 只有一端存在的文件按所在端归入 remoteAdded / localAdded。
 */
export const buildPlan = (localIndex: FileIndex, remoteIndex: FileIndex): PlanGroups => {
  const local = indexMap(localIndex)
  const remote = indexMap(remoteIndex)
  const groups = emptyGroups()

  const paths = new Set<string>([...local.keys(), ...remote.keys()])
  for (const path of Array.from(paths).sort()) {
    const localFile = local.get(path)
    const remoteFile = remote.get(path)

    if (localFile && remoteFile) continue
    const group: FileGroupKey = localFile ? 'localAdded' : 'remoteAdded'

    groups[group].push({
      group,
      path,
      localSize: localFile ? localFile.size : null,
      remoteSize: remoteFile ? remoteFile.size : null,
      defaultChecked: true,
      defaultDirection: group === 'remoteAdded' ? 'pull' : 'push',
    })
  }

  return groups
}

export const planSelectionKey = (group: FileGroupKey, path: string) => `${group}:${path}`

/** 把用户的勾选结果转换成实际要执行的传输动作 */
export const buildActions = (
  plan: PlanGroups,
  selection: Readonly<Record<string, boolean>>,
): TransferAction[] => {
  const actions: TransferAction[] = []
  for (const group of FILE_GROUP_KEYS) {
    for (const item of plan[group]) {
      if (!selection[planSelectionKey(group, item.path)]) continue
      switch (group) {
        case 'remoteAdded':
          actions.push({ kind: 'download', path: item.path, size: item.remoteSize ?? 0 })
          break
        case 'localAdded':
          actions.push({ kind: 'upload', path: item.path, size: item.localSize ?? 0 })
          break
      }
    }
  }
  return actions
}

const parentsOf = (dir: string) => {
  const parents: string[] = []
  let index = dir.lastIndexOf('/')
  while (index > 0) {
    parents.push(dir.substring(0, index))
    index = dir.lastIndexOf('/', index - 1)
  }
  return parents
}
