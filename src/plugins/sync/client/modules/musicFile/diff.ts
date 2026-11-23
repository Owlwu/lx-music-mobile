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

/**
 * 伴生封面扩展名（只认**小写**，与播放链路读取同名封面的规则一致）。
 * `.JPG/.PNG` 不参与索引（见契约 `docs/phase6-sync-sidecar-design.md` §2）。
 */
export const COVER_EXTENSIONS = ['jpg', 'png'] as const

export type CoverFormat = typeof COVER_EXTENSIONS[number]

export type FileGroupKey = 'remoteAdded' | 'localAdded' | 'remoteDeleted' | 'localDeleted' | 'conflict'

export const FILE_GROUP_KEYS: FileGroupKey[] = ['remoteAdded', 'localAdded', 'remoteDeleted', 'localDeleted', 'conflict']

export interface LyricItem {
  size: number
  mtime: number
}

/** 同目录同名的封面（jpg 优先于 png） */
export interface CoverItem {
  format: CoverFormat
  size: number
  mtime: number
}

/**
 * 跟随歌曲传输/删除的伴生文件。
 * `path` 是相对同步根目录的 POSIX 路径，落点由两端按同一规则从音频路径推导。
 */
export interface SidecarItem {
  path: string
  size: number
  kind: 'lyric' | 'cover'
}

export interface FileItem {
  /** 相对同步根目录的路径，使用 `/` 分隔 */
  path: string
  size: number
  mtime: number
  /**
   * 内容签名（见 `buildSignature`）。对端版本较旧或取样失败时为 undefined，
   * 此时该文件退回「只比 size」的旧判定。
   */
  sig?: string
  /** 同目录同名的 .lrc 文件信息，不存在时为 null */
  lyric: LyricItem | null
  /** 同目录同名的 .jpg/.png 文件信息（jpg 优先），不存在时为 null */
  cover: CoverItem | null
}

export interface FileIndex {
  /** 索引中出现过的文件夹相对路径（去重、字典序） */
  folders: string[]
  /** 索引中的音频文件（按 path 字典序） */
  files: FileItem[]
  /**
   * 本端扫描器是否支持封面索引（新版本恒为 true）。
   * 旧对端没有该字段，发起端因此不传/不删对端封面，避免覆盖旧对端已有封面。
   */
  coverSupport?: boolean
}

export interface PlanItem {
  group: FileGroupKey
  path: string
  localSize: number | null
  remoteSize: number | null
  localHasLyric: boolean
  remoteHasLyric: boolean
  localHasCover: boolean
  remoteHasCover: boolean
  /** 方向为 upload 时要顺带传的伴生文件（源本地有、对端没有；cover 需 remoteCoverSupport） */
  uploadSidecars: SidecarItem[]
  /** 方向为 download 时要顺带传的伴生文件（源对端有、本地没有；cover 需 remoteCoverSupport） */
  downloadSidecars: SidecarItem[]
  /** delete_local 时要删除的本地伴生文件 */
  localSidecars: SidecarItem[]
  /** delete_remote 时要删除的对端伴生文件（cover 需 remoteCoverSupport） */
  remoteSidecars: SidecarItem[]
  defaultChecked: boolean
  defaultDirection: TransferDirection
  /** conflict 专用：true 表示两端字节数相同、只是内容不同（否则是大小不同） */
  sameSize?: boolean
}

export type TransferDirection = 'push' | 'pull'

export type PlanGroups = Record<FileGroupKey, PlanItem[]>

export interface ScanEntry {
  /** 相对路径 */
  path: string
  size: number
  mtime: number
  /** 音频文件的内容签名（见 `buildSignature`）；歌词/封面等伴生文件不需要 */
  sig?: string
}

/**
 * 传输/删除动作携带的伴生文件列表（取代旧版的 `hasLyric: boolean`）。
 * - download/upload：源侧有、目标侧没有的伴生文件（target 已有 → 不传，不覆盖）；
 * - delete_local / delete_remote：该侧实际存在的伴生文件。
 */
export type TransferAction =
  | { kind: 'download', path: string, size: number, sidecars: SidecarItem[] }
  | { kind: 'upload', path: string, size: number, sidecars: SidecarItem[] }
  | { kind: 'delete_local', path: string, sidecars: SidecarItem[] }
  | { kind: 'delete_remote', path: string, sidecars: SidecarItem[] }

export const getExt = (name: string) => {
  const index = name.lastIndexOf('.')
  return index > 0 && index < name.length - 1 ? name.substring(index + 1).toLowerCase() : ''
}

export const isAudioFileName = (name: string) => (AUDIO_EXTENSIONS as readonly string[]).includes(getExt(name))

export const isLyricFileName = (name: string) => getExt(name) === LYRIC_EXTENSION

/** 取未转小写的扩展名：封面只认小写 `.jpg/.png`，不能用会 lowercase 的 `getExt` */
const getRawExt = (name: string) => {
  const index = name.lastIndexOf('.')
  return index > 0 && index < name.length - 1 ? name.substring(index + 1) : ''
}

/** 是否为参与同步的封面（只认小写 jpg/png） */
export const isCoverFileName = (name: string) => {
  const ext = getRawExt(name)
  return ext === 'jpg' || ext === 'png'
}

/** 封面格式；不是小写 jpg/png 时返回 null */
export const getCoverFormat = (name: string): CoverFormat | null => {
  const ext = getRawExt(name)
  return ext === 'jpg' || ext === 'png' ? ext : null
}

/** 去掉最后一个扩展名的相对路径（`a/b/c.flac` -> `a/b/c`） */
const getStemRelPath = (relPath: string) => {
  const index = relPath.lastIndexOf('.')
  return index > 0 ? relPath.substring(0, index) : relPath
}

/** `a/b/c.flac` -> `a/b/c.lrc` */
export const getLyricFileName = (name: string) => {
  const index = name.lastIndexOf('.')
  return (index > 0 ? name.substring(0, index) : name) + '.' + LYRIC_EXTENSION
}

/** `a/b/c.flac` -> `a/b/c.lrc` */
export const getLyricRelPath = (relPath: string) => getStemRelPath(relPath) + '.' + LYRIC_EXTENSION

/** `a/b/c.flac` -> `a/b/c.jpg`（或 `.png`） */
export const getCoverFileName = (name: string, format: CoverFormat) => {
  const index = name.lastIndexOf('.')
  return (index > 0 ? name.substring(0, index) : name) + '.' + format
}

/** `a/b/c.flac` -> `a/b/c.jpg`（或 `.png`） */
export const getCoverRelPath = (relPath: string, format: CoverFormat) => getStemRelPath(relPath) + '.' + format

/**
 * 内容签名：用于发现「字节数相同但内容不同」的文件
 *
 * 只用 size 判断相等性时，任何**保持字节数**的改动都发现不了。最典型的就是把
 * 加密/混淆过的音频原地解密还原：XOR 类解密前后字节数完全一致，两端会一直认为
 * 「已同步」，于是对端永远拿不到正常文件，表现为「扫描并比较 → 两端一致，
 * 无需同步」但手机上仍然解析失败。
 *
 * 所以扫描时额外取文件「首段 + 尾段」算一个廉价的 64 位签名：
 *
 *   payload = ascii(`mf1:${size}:`) + 首段字节 + 尾段字节
 *   sig     = fnv1a32(payload) 与 djb2_32(payload) 各 32 位，拼成 16 位十六进制
 *
 * 契约（两端必须完全一致）：
 * - 取样范围见 `getSignatureRanges`：首尾各 4096 字节；文件更小时取整文件，首尾不重叠。
 * - 签名是「内容是否变化」的探测器，不是安全校验；对端没给签名时退回只比 size。
 * - 布局变化（版本号 `mf1` 变化）会让两端签名整体失配，因此变更时必须同步升级两端。
 */
export const SIGNATURE_SAMPLE_BYTES = 4096

/** 取样范围：head 从 0 开始，tail 与 head 不重叠 */
export const getSignatureRanges = (size: number) => {
  const headLength = Math.max(0, Math.min(SIGNATURE_SAMPLE_BYTES, size))
  const tailOffset = Math.max(headLength, size - SIGNATURE_SAMPLE_BYTES)
  const tailLength = Math.max(0, size - tailOffset)
  return { headLength, tailOffset, tailLength }
}

const SIG_A_OFFSET = 0x811c9dc5
const SIG_A_PRIME = 16777619
const SIG_B_OFFSET = 5381
const SIG_B_PRIME = 33

const hex32 = (value: number) => (value >>> 0).toString(16).padStart(8, '0')

/** 只处理 ASCII 前缀，避免依赖 TextEncoder（RN 上不保证存在） */
const asciiBytes = (text: string) => {
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff
  return bytes
}

/** 由大小 + 首段 + 尾段字节算出内容签名；同一份内容在任何一端都得到同一个值 */
export const buildSignature = (size: number, head: Uint8Array, tail: Uint8Array): string => {
  let a = SIG_A_OFFSET >>> 0
  let b = SIG_B_OFFSET >>> 0
  const push = (bytes: Uint8Array) => {
    for (let i = 0; i < bytes.length; i++) {
      const value = bytes[i]
      a = Math.imul(a ^ value, SIG_A_PRIME) >>> 0
      b = (Math.imul(b, SIG_B_PRIME) + value) >>> 0
    }
  }
  push(asciiBytes(`mf1:${size}:`))
  push(head)
  push(tail)
  return hex32(a) + hex32(b)
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
 * 由扫描结果构建索引：只保留音频文件，并把同目录同名的 `.lrc` 与 `.jpg/.png`
 * 挂到对应音频上（契约 §2：jpg 优先、png 回退；对端任意一种存在即“已有封面”）。
 * 传入的 `entries` 是目录下所有文件的原始列表（含歌词/封面），函数内部完成配对。
 */
export const buildIndex = (entries: readonly ScanEntry[]): FileIndex => {
  // 索引里统一存放 NFC 规范路径：两端才能对同一个文件得出同一个 path
  const canonical = entries.map(entry => ({ ...entry, path: canonicalizeRelPath(normalizeRelPath(entry.path)) }))
  const lyricMap = new Map<string, LyricItem>()
  const coverMap = new Map<string, CoverItem>()
  for (const entry of canonical) {
    if (isLyricFileName(entry.path)) {
      lyricMap.set(entry.path, { size: entry.size, mtime: entry.mtime })
      continue
    }
    const format = getCoverFormat(entry.path)
    if (!format) continue
    const key = getStemRelPath(entry.path)
    // 同名 jpg 与 png 同时存在时按播放优先级取 jpg，不因目录枚举顺序而变化
    const existing = coverMap.get(key)
    if (existing?.format === 'jpg') continue
    coverMap.set(key, { format, size: entry.size, mtime: entry.mtime })
  }

  const folderSet = new Set<string>()
  const files: FileItem[] = []
  for (const entry of canonical) {
    if (!isAudioFileName(entry.path)) continue
    files.push({
      path: entry.path,
      size: entry.size,
      mtime: entry.mtime,
      sig: entry.sig,
      lyric: lyricMap.get(getLyricRelPath(entry.path)) ?? null,
      cover: coverMap.get(getStemRelPath(entry.path)) ?? null,
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

/** 单个动作的执行结果：只有成功完成的动作才允许改动同步基线 */
export interface ExecutedAction {
  kind: TransferAction['kind']
  path: string
  ok: boolean
}

/** 把已完成动作落到基线上；未勾选、失败、未执行的动作保持原状态 */
const mergeExecutedBaseline = (prev: readonly string[], executed: readonly ExecutedAction[]) => {
  const next = new Set(prev)
  for (const item of executed) {
    if (!item.ok) continue
    if (item.kind === 'upload' || item.kind === 'download') next.add(item.path)
    else next.delete(item.path)
  }
  return next
}

/**
 * 取消 / 中途退出时的基线更新：不重新扫描，只写入已完成动作的结果。
 * 剩余动作保持上一次基线的状态，下一轮仍按删除或新增提示用户。
 */
export const applyExecutedToBaseline = (prev: readonly string[], executed: readonly ExecutedAction[]) =>
  Array.from(mergeExecutedBaseline(prev, executed)).sort()

/**
 * 正常收尾时的基线更新。
 *
 * 与旧的「整体替换成两端交集」相比，这里只做增量：
 * - 本轮结束时两端都存在的文件补进基线（覆盖同步成功但伴生文件失败的情况）；
 * - 执行成功的删除移出基线；
 * - 未勾选 / 失败的条目原样保留，否则跳过一次删除后，下一轮会把它当成新增并默认勾选上传。
 * 只清除当前 scope 内、两端都已不存在的条目；scope 外的记忆保留。
 */
export const computeNextBaseline = (
  prev: readonly string[],
  executed: readonly ExecutedAction[],
  finalLocal: FileIndex,
  finalRemote: FileIndex,
  scope: readonly string[] = [],
) => {
  const next = mergeExecutedBaseline(prev, executed)
  for (const path of buildBaseline(finalLocal, finalRemote)) next.add(path)
  const present = new Set([...finalLocal.files, ...finalRemote.files].map(file => file.path))
  return Array.from(next)
    .filter(path => present.has(path) || !isPathInScope(path, scope))
    .sort()
}

/** 基线归属：对端设备 + 对端根目录。任一项变化都按首次同步处理 */
export interface BaselineKey {
  deviceName: string
  remoteRoot: string
}

/** 基线文件版本；旧版是裸数组，因结构不符会按空基线处理 */
export const BASELINE_VERSION = 1

/**
 * 解析基线文件内容（纯逻辑，便于直接用 node 测试）。
 *
 * 旧版基线是裸数组，没有设备/根目录信息：沿用一次并原样返回，
 * 下一次保存会升级成带键格式。若直接按空基线处理，升级后的第一轮
 * 会把用户跳过的删除项当成「新增」并默认勾选上传。
 */
export const parseBaseline = (raw: string, key: BaselineKey): string[] => {
  try {
    const data = JSON.parse(raw)
    if (Array.isArray(data)) return data.filter((item: unknown): item is string => typeof item === 'string')
    if (!data || typeof data !== 'object') return []
    if (data.version !== BASELINE_VERSION) return []
    if (data.deviceName !== key.deviceName || data.remoteRoot !== key.remoteRoot) return []
    return Array.isArray(data.paths) ? data.paths.filter((item: unknown): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
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

const toLyricSidecar = (path: string, lyric: LyricItem | null): SidecarItem | null => {
  return lyric ? { path: getLyricRelPath(path), size: lyric.size, kind: 'lyric' } : null
}

const toCoverSidecar = (path: string, cover: CoverItem | null): SidecarItem | null => {
  return cover ? { path: getCoverRelPath(path, cover.format), size: cover.size, kind: 'cover' } : null
}

/**
 * 按契约 1.2 分类变更。
 *
 * 相等性判定（mtime 始终不参与）：
 * - size 不同 → 内容不同；
 * - size 相同、且两端都带内容签名 → 再比签名，签名不同视为内容不同
 *   （发现「字节数相同但内容不同」，例如原地解密过的音频）；
 * - 任一端没有签名（旧版本对端、或取样失败）→ 退回只比 size 的旧行为。
 *
 * 伴生文件**不参与**变更判定：只改 `.lrc` / `.jpg` / `.png` 不会产生 PlanItem。
 * sidecar 列表只表达「跟随哪次传输/删除、且 target 没有才带上」，不会覆盖 target 已有文件。
 */
export const buildPlan = (localIndex: FileIndex, remoteIndex: FileIndex, baseline: readonly string[]): PlanGroups => {
  const local = indexMap(localIndex)
  const remote = indexMap(remoteIndex)
  const baselineSet = new Set(baseline)
  const groups = emptyGroups()
  // 旧对端没有封面索引能力：不传、不删对端封面（避免覆盖），歌词规则不受影响
  const remoteCoverSupport = remoteIndex.coverSupport === true

  const paths = new Set<string>([...local.keys(), ...remote.keys()])
  for (const path of Array.from(paths).sort()) {
    const localFile = local.get(path)
    const remoteFile = remote.get(path)
    const inBaseline = baselineSet.has(path)

    let group: FileGroupKey
    let sameSize = false
    if (localFile && remoteFile) {
      if (localFile.size === remoteFile.size) {
        const localSig = localFile.sig
        const remoteSig = remoteFile.sig
        // 两端都有签名时才做内容比对；签名一致 = 内容一致
        if (!localSig || !remoteSig || localSig === remoteSig) continue
        sameSize = true
      }
      group = 'conflict'
    } else if (localFile) {
      group = inBaseline ? 'remoteDeleted' : 'localAdded'
    } else if (remoteFile) {
      group = inBaseline ? 'localDeleted' : 'remoteAdded'
    } else continue

    const localLyric = localFile?.lyric ?? null
    const remoteLyric = remoteFile?.lyric ?? null
    const localCover = localFile?.cover ?? null
    const remoteCover = remoteFile?.cover ?? null
    const localLyricSidecar = toLyricSidecar(path, localLyric)
    const remoteLyricSidecar = toLyricSidecar(path, remoteLyric)
    const localCoverSidecar = toCoverSidecar(path, localCover)
    // 对端封面只在支持封面索引时才参与（旧对端无论有没有 cover 都不动）
    const remoteCoverSidecar = remoteCoverSupport ? toCoverSidecar(path, remoteCover) : null

    // 删除该侧实际存在的伴生文件（本地侧总是参与；对端封面受 coverSupport 限制）
    const localSidecars: SidecarItem[] = []
    if (localLyricSidecar) localSidecars.push(localLyricSidecar)
    if (localCoverSidecar) localSidecars.push(localCoverSidecar)
    const remoteSidecars: SidecarItem[] = []
    if (remoteLyricSidecar) remoteSidecars.push(remoteLyricSidecar)
    if (remoteCoverSidecar) remoteSidecars.push(remoteCoverSidecar)

    // 传输侧：源有、target 没有才带；target 已有任意一种封面格式都算“已有封面”
    const uploadSidecars: SidecarItem[] = []
    if (localLyricSidecar && !remoteLyric) uploadSidecars.push({ ...localLyricSidecar })
    if (remoteCoverSupport && localCoverSidecar && !remoteCover) uploadSidecars.push({ ...localCoverSidecar })
    const downloadSidecars: SidecarItem[] = []
    if (remoteLyricSidecar && !localLyric) downloadSidecars.push({ ...remoteLyricSidecar })
    if (remoteCoverSidecar && !localCover) downloadSidecars.push({ ...remoteCoverSidecar })

    groups[group].push({
      group,
      path,
      localSize: localFile ? localFile.size : null,
      remoteSize: remoteFile ? remoteFile.size : null,
      localHasLyric: localLyric != null,
      remoteHasLyric: remoteLyric != null,
      localHasCover: localCover != null,
      remoteHasCover: remoteCover != null,
      uploadSidecars,
      downloadSidecars,
      localSidecars,
      remoteSidecars,
      defaultChecked: getDefaultChecked(group),
      defaultDirection: getDefaultDirection(group),
      sameSize: group === 'conflict' ? sameSize : undefined,
    })
  }

  return groups
}

export const planSelectionKey = (group: FileGroupKey, path: string) => `${group}:${path}`

/**
 * 把用户的勾选结果转换成实际要执行的传输动作。
 * 每个动作都携带伴生歌词/封面列表，保证伴生文件跟随歌曲一起传输/删除。
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
          actions.push({ kind: 'download', path: item.path, size: item.remoteSize ?? 0, sidecars: [...item.downloadSidecars] })
          break
        case 'localAdded':
          actions.push({ kind: 'upload', path: item.path, size: item.localSize ?? 0, sidecars: [...item.uploadSidecars] })
          break
        case 'remoteDeleted':
          actions.push({ kind: 'delete_local', path: item.path, sidecars: [...item.localSidecars] })
          break
        case 'localDeleted':
          actions.push({ kind: 'delete_remote', path: item.path, sidecars: [...item.remoteSidecars] })
          break
        case 'conflict':
          if ((directions[planSelectionKey(group, item.path)] ?? item.defaultDirection) === 'pull') {
            actions.push({ kind: 'download', path: item.path, size: item.remoteSize ?? 0, sidecars: [...item.downloadSidecars] })
          } else {
            actions.push({ kind: 'upload', path: item.path, size: item.localSize ?? 0, sidecars: [...item.uploadSidecars] })
          }
          break
      }
    }
  }
  return actions
}

/**
 * 单个动作实际要读/写/删的路径列表：音频 + 伴生文件（契约 §5 `targetsOf`）。
 *
 * 传输端对每个路径走既有 `musicFile_read_file` / `musicFile_write_file`；
 * 删除端对每个路径走 `musicFile_delete_file(path, false)`（不改 RPC 签名）。
 */
export const getActionTargets = (action: TransferAction): string[] => [
  action.path,
  ...action.sidecars.map(sidecar => sidecar.path),
]

const parentsOf = (dir: string) => {
  const parents: string[] = []
  let index = dir.lastIndexOf('/')
  while (index > 0) {
    parents.push(dir.substring(0, index))
    index = dir.lastIndexOf('/', index - 1)
  }
  return parents
}
