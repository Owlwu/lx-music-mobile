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

/** 伴生歌词文件的扩展名 */
export const LYRIC_EXTENSION = 'lrc'

export type FileGroupKey = 'remoteAdded' | 'localAdded' | 'remoteDeleted' | 'localDeleted' | 'conflict'

export const FILE_GROUP_KEYS: FileGroupKey[] = ['remoteAdded', 'localAdded', 'remoteDeleted', 'localDeleted', 'conflict']

export interface LyricItem {
  size: number
  mtime: number
}

export interface FileItem {
  /** 相对同步根目录的路径，使用 `/` 分隔 */
  path: string
  size: number
  mtime: number
  /** 同目录同名的 .lrc 文件信息，不存在时为 null */
  lyric: LyricItem | null
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
  localHasLyric: boolean
  remoteHasLyric: boolean
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
  | { kind: 'download', path: string, size: number, hasLyric: boolean }
  | { kind: 'upload', path: string, size: number, hasLyric: boolean }
  | { kind: 'delete_local', path: string, hasLyric: boolean }
  | { kind: 'delete_remote', path: string, hasLyric: boolean }

export const getExt = (name: string) => {
  const index = name.lastIndexOf('.')
  return index > 0 && index < name.length - 1 ? name.substring(index + 1).toLowerCase() : ''
}

export const isAudioFileName = (name: string) => (AUDIO_EXTENSIONS as readonly string[]).includes(getExt(name))

export const isLyricFileName = (name: string) => getExt(name) === LYRIC_EXTENSION

/** `a/b/c.flac` -> `a/b/c.lrc` */
export const getLyricFileName = (name: string) => {
  const index = name.lastIndexOf('.')
  return (index > 0 ? name.substring(0, index) : name) + '.' + LYRIC_EXTENSION
}

/** `a/b/c.flac` -> `a/b/c` */
export const getLyricRelPath = (relPath: string) => {
  const index = relPath.lastIndexOf('.')
  return (index > 0 ? relPath.substring(0, index) : relPath) + '.' + LYRIC_EXTENSION
}

/** 统一分隔符并去掉多余的前导 `./` */
export const normalizeRelPath = (relPath: string) => relPath.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/{2,}/g, '/')

/**
 * 把相对路径的每一段统一成 NFC。
 *
 * 日文假名（如「ぼ」）存在两种等价写法：PC 常见 NFC（U+307C），Android 常见 NFD
 * （U+307B U+3099）。两者是**同一个文件名**，但字符串比较不相等，
 * 于是同一個文件会被两端各自判成“对方没有”，表现为反复出现的
 * 「本地新增」+「对端新增」且大小完全相同。
 *
 * 统一到 NFC：基线里既有的条目本身就是 NFC，因此不会造成已有数据失配。
 */
export const canonicalizeRelPath = (relPath: string) =>
  relPath.split('/').map(segment => segment.normalize('NFC')).join('/')

/**
 * 单个路径名的最大字节数（UTF-8）。
 *
 * Android 的 NAME_MAX 是 255 字节，而日文/中文文件名一个字占 3 字节，
 * 长标题很容易超限，直接写入会报 ENAMETOOLONG 导致整个文件同步失败。
 * 这里留出余量，同时给伴生歌词的 `.lrc` 追加留够空间。
 */
export const MAX_NAME_BYTES = 240

/** 截断后追加的短哈希长度（十六进制字符数） */
const SHORT_HASH_LENGTH = 8

/** 判定是否纯 ASCII（用于决定扩展名能否单独保留）：ASCII 时字节数等于字符数 */
const isAsciiOnly = (name: string) => utf8ByteLength(name) === name.length

/** 歌手列表之间的分隔符（与库内既有命名保持一致，按优先级尝试） */
const ARTIST_SEPARATORS = [' _ ', '、', ', ', ' & ', ' ; ', ' / ']

/** 认作“歌手列表”的下限：至少 2 个名字才值得压缩 */
const MIN_ARTIST_ITEMS = 2

/**
 * 把歌手列表按分隔符切成若干条，全部保留原文（不做二次加工）。
 * 找不到分隔符则返回 null，表示字面上不是歌手列表。
 */
const splitArtistList = (text: string): string[] | null => {
  for (const sep of ARTIST_SEPARATORS) {
    const parts = text.split(sep).map(item => item.trim())
    if (parts.length >= MIN_ARTIST_ITEMS && parts.every(item => item.length > 0)) return parts
  }
  return null
}

/**
 * 生成“n 项”的提示：ASCII 用 `+k more`，其它情况用 `等k项`。
 * 取更短的那个，尽量把字节预算留给名字本身。
 */
const moreMarker = (remaining: number) => {
  const ascii = ` +${remaining} more`
  const cjk = `等${remaining}项`
  return utf8ByteLength(ascii) <= utf8ByteLength(cjk) ? ascii : cjk
}

/**
 * 按分隔符逐条截断，尽量保留“完整的人名”。
 *
 * 关键点：截断发生在**条目之间**，不会把最后一个人的名字切成半个；
 * 全部放不下时至少保留第一项，并优先用省略号表达“还有更多”。
 */
const shortenList = (parts: string[], budget: number, joiner: string): string => {
  if (!parts.length) return ''
  // 挑一个能塞进预算的“还有更多”标记（数字位数越多标记越长）
  let marker = ''
  for (let remaining = parts.length - 1; remaining >= 1; remaining--) {
    const candidate = moreMarker(remaining)
    if (utf8ByteLength(parts[0] + joiner + candidate) <= budget) { marker = candidate; break }
  }
  if (marker) {
    const keep: string[] = []
    for (const part of parts) {
      const next = [...keep, part].join(joiner)
      if (utf8ByteLength(next + joiner + marker) > budget) break
      keep.push(part)
    }
    if (keep.length) return keep.join(joiner) + joiner + marker
  }
  // 连标记都放不下：只保留第一项，必要时再压缩它
  return utf8Truncate(parts[0], Math.max(0, budget))
}

/** 用省略号压缩一段文字：头 + … + 尾，尽量保留两端信息 */
const shortenText = (text: string, budget: number): string => {
  if (utf8ByteLength(text) <= budget) return text
  const ellipsis = '…'
  const ellipsisBytes = utf8ByteLength(ellipsis)
  if (budget <= ellipsisBytes) return utf8Truncate(text, budget)
  const inner = budget - ellipsisBytes
  const head = utf8Truncate(text, Math.floor(inner * 0.6))
  const tail = utf8Truncate([...text].reverse().join(''), inner - utf8ByteLength(head))
  return head + ellipsis + [...tail].reverse().join('')
}

/**
 * 按“歌曲名 + 歌手列表”的命名约定压限：
 * 优先压缩歌手列表，歌曲名能不动就不动；
 * 只有当歌曲名本身都超出预算时，才对它做头尾保留式压缩。
 *
 * 压缩后的名字仍然唯一：末尾追加取自**原始全名**的 8 位哈希，
 * 因此同一个文件在任何一端、任何一次同步都会得到同一个名字。
 */
const shortenSongName = (base: string, extBytes: number = 0): string => {
  const marker = `.${shortHash(base)}`
  // 预算要同时扣掉：哈希标记、扩展名（含其前面的点）
  const textBudget = MAX_NAME_BYTES - utf8ByteLength(marker) - (extBytes > 0 ? extBytes + 1 : 0)
  const index = base.lastIndexOf(' - ')
  let song = base
  let artists: string | null = null
  let parts: string[] | null = null
  if (index > 0) {
    const left = base.slice(0, index)
    const right = base.slice(index + 3)
    const rightParts = splitArtistList(right)
    const leftParts = splitArtistList(left)
    if (rightParts) {
      song = left
      artists = right
      parts = rightParts
    } else if (leftParts) {
      song = right
      artists = left
      parts = leftParts
    }
  }

  if (parts != null && artists != null) {
    // 先按“整名预算 - 歌曲名 - 分隔符”压歌手列表；放不下时 loosen 会把歌曲名一起压
    const artistsBudget = Math.max(0, textBudget - utf8ByteLength(song) - 3)
    let shortArtists = shortenList(parts, artistsBudget, ' _ ')
    let shortSong = song
    if (utf8ByteLength(shortSong) + 3 + utf8ByteLength(shortArtists) > textBudget) {
      shortSong = shortenText(song, Math.max(0, textBudget - 3 - utf8ByteLength(shortArtists)))
      // 极少数情况下歌曲名压完仍超，再把歌手列表收紧一次
      if (utf8ByteLength(shortSong) + 3 + utf8ByteLength(shortArtists) > textBudget) {
        shortArtists = shortenList(parts, Math.max(0, textBudget - 3 - utf8ByteLength(shortSong)), ' _ ')
      }
    }
    return `${shortSong} - ${shortArtists}${marker}`
  }

  // 没有可识别的歌手列表：整名头尾保留
  return `${shortenText(base, textBudget)}${marker}`
}


/** UTF-8 字节长度（不依赖 Buffer/TextEncoder，两端保持一致） */
export const utf8ByteLength = (str: string): number => {
  let bytes = 0
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xD800 && code <= 0xDBFF) {
      // 高代理项与后面的低代理项合成一个码点，占 4 字节
      bytes += 4
      i++
    } else bytes += 3
  }
  return bytes
}

/** 按 UTF-8 字节预算截断，保证不会把一个字符切成半个 */
export const utf8Truncate = (str: string, maxBytes: number): string => {
  let bytes = 0
  let out = ''
  for (const char of str) {
    const size = utf8ByteLength(char)
    if (bytes + size > maxBytes) break
    bytes += size
    out += char
  }
  return out
}

/** FNV-1a 32 位哈希，转成 8 位十六进制：纯 JS 实现，保证两端结果一致 */
export const shortHash = (value: string): string => {
  let hash = 0x811C9DC5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    // hash *= 16777619，用移位避免 32 位溢出精度丢失
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return hash.toString(16).padStart(SHORT_HASH_LENGTH, '0')
}

/**
 * 把单个路径名压到 `MAX_NAME_BYTES` 以内。
 *
 * 规则（两端必须完全一致）：
 * - 未超限：原样返回；
 * - 超限：`<截断后的主名>.<8位哈希>.<扩展名>`，哈希取自**原始完整名**，
 *   因此同一文件在任何一端、任何次数都会得到同一个名字，不会反复改名；
 * - 扩展名只在 ASCII 且较短时保留，否则并入主名一并截断。
 */
export const shortenName = (name: string): string => {
  if (utf8ByteLength(name) <= MAX_NAME_BYTES) return name

  const dot = name.lastIndexOf('.')
  let base = name
  let ext = ''
  if (dot > 0 && dot < name.length - 1) {
    const candidate = name.substring(dot + 1)
    if (isAsciiOnly(candidate) && candidate.length <= 10) {
      base = name.substring(0, dot)
      ext = candidate
    }
  }
  return shortenSongName(base, utf8ByteLength(ext)) + (ext.length ? '.' + ext : '')
}

/** 对相对路径里的每一段分别压限，保持目录层级不变 */
export const shortenRelPath = (relPath: string): string =>
  relPath.split('/').map(shortenName).join('/')

/** 该相对路径是否会被压限（用于日志与提示） */
export const isRelPathTooLong = (relPath: string): boolean =>
  relPath.split('/').some(segment => utf8ByteLength(segment) > MAX_NAME_BYTES)


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
 * 由扫描结果构建索引：只保留音频文件，并把同目录同名的 .lrc 挂到对应音频上。
 * 传入的 `entries` 是目录下所有文件的原始列表（含 .lrc），函数内部完成配对。
 */
export const buildIndex = (entries: readonly ScanEntry[]): FileIndex => {
  // 索引里统一存放 NFC 规范路径：两端才能对同一个文件得出同一个 path
  const canonical = entries.map(entry => ({ ...entry, path: canonicalizeRelPath(normalizeRelPath(entry.path)) }))
  const lyricMap = new Map<string, LyricItem>()
  for (const entry of canonical) {
    if (!isLyricFileName(entry.path)) continue
    lyricMap.set(entry.path, { size: entry.size, mtime: entry.mtime })
  }

  const folderSet = new Set<string>()
  const files: FileItem[] = []
  for (const entry of canonical) {
    if (!isAudioFileName(entry.path)) continue
    files.push({
      path: entry.path,
      size: entry.size,
      mtime: entry.mtime,
      lyric: lyricMap.get(getLyricRelPath(entry.path)) ?? null,
    })
    const dir = getRelDir(entry.path)
    if (!dir.length) continue
    for (const folder of [dir, ...parentsOf(dir)]) folderSet.add(folder)
  }

  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  return { folders: Array.from(folderSet).sort(), files }
}

/** 由索引中所有 path 构建基线（两端都存在的文件才进入基线） */
export const buildBaseline = (localIndex: FileIndex, remoteIndex: FileIndex) => {
  const remotePaths = new Set(remoteIndex.files.map(file => file.path))
  return localIndex.files.map(file => file.path).filter(path => remotePaths.has(path)).sort()
}

const indexMap = (index: FileIndex) => {
  const map = new Map<string, FileItem>()
  for (const file of index.files) map.set(file.path, file)
  return map
}

const emptyGroups = (): PlanGroups => ({
  remoteAdded: [],
  localAdded: [],
  remoteDeleted: [],
  localDeleted: [],
  conflict: [],
})

export const getDefaultChecked = (group: FileGroupKey) => group === 'remoteAdded' || group === 'localAdded'

export const getDefaultDirection = (group: FileGroupKey): TransferDirection => {
  switch (group) {
    case 'remoteAdded':
    case 'localDeleted':
    case 'conflict':
      return 'pull'
    default:
      return 'push'
  }
}

/**
 * 按契约 1.2 分类变更。size 相同即视为内容一致（mtime 不参与判断）。
 */
export const buildPlan = (localIndex: FileIndex, remoteIndex: FileIndex, baseline: readonly string[]): PlanGroups => {
  const local = indexMap(localIndex)
  const remote = indexMap(remoteIndex)
  const baselineSet = new Set(baseline)
  const groups = emptyGroups()

  const paths = new Set<string>([...local.keys(), ...remote.keys()])
  for (const path of Array.from(paths).sort()) {
    const localFile = local.get(path)
    const remoteFile = remote.get(path)
    const inBaseline = baselineSet.has(path)

    let group: FileGroupKey
    if (localFile && remoteFile) {
      if (localFile.size === remoteFile.size) continue
      group = 'conflict'
    } else if (localFile) {
      group = inBaseline ? 'remoteDeleted' : 'localAdded'
    } else if (remoteFile) {
      group = inBaseline ? 'localDeleted' : 'remoteAdded'
    } else continue

    groups[group].push({
      group,
      path,
      localSize: localFile ? localFile.size : null,
      remoteSize: remoteFile ? remoteFile.size : null,
      localHasLyric: localFile?.lyric != null,
      remoteHasLyric: remoteFile?.lyric != null,
      defaultChecked: getDefaultChecked(group),
      defaultDirection: getDefaultDirection(group),
    })
  }

  return groups
}

export const planSelectionKey = (group: FileGroupKey, path: string) => `${group}:${path}`

/**
 * 把用户的勾选结果转换成实际要执行的传输动作。
 * 每个动作都携带伴生 .lrc，保证歌词跟随歌曲一起传输/删除。
 */
export const buildActions = (
  plan: PlanGroups,
  selection: Readonly<Record<string, boolean>>,
  directions: Readonly<Record<string, TransferDirection>>,
): TransferAction[] => {
  const actions: TransferAction[] = []
  for (const group of FILE_GROUP_KEYS) {
    for (const item of plan[group]) {
      if (!selection[planSelectionKey(group, item.path)]) continue
      switch (group) {
        case 'remoteAdded':
          actions.push({ kind: 'download', path: item.path, size: item.remoteSize ?? 0, hasLyric: item.remoteHasLyric })
          break
        case 'localAdded':
          actions.push({ kind: 'upload', path: item.path, size: item.localSize ?? 0, hasLyric: item.localHasLyric })
          break
        case 'remoteDeleted':
          actions.push({ kind: 'delete_local', path: item.path, hasLyric: item.localHasLyric })
          break
        case 'localDeleted':
          actions.push({ kind: 'delete_remote', path: item.path, hasLyric: item.remoteHasLyric })
          break
        case 'conflict':
          if ((directions[planSelectionKey(group, item.path)] ?? item.defaultDirection) === 'pull') {
            actions.push({ kind: 'download', path: item.path, size: item.remoteSize ?? 0, hasLyric: item.remoteHasLyric })
          } else {
            actions.push({ kind: 'upload', path: item.path, size: item.localSize ?? 0, hasLyric: item.localHasLyric })
          }
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
