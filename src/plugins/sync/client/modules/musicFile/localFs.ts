import {
  assertSafeRelPath,
  buildIndex,
  buildSignature,
  canonicalizeRelPath,
  getLyricRelPath,
  getRelDir,
  getSignatureRanges,
  isAudioFileName,
  isLyricFileName,
  shortenRelPath,
  type FileIndex,
  type ScanEntry,
} from './diff'
import {
  appendFile,
  copyFile,
  existsFile,
  mkdir,
  readDir,
  readFileSlice,
  stat,
  temporaryDirectoryPath,
  unlink,
  writeFile,
} from '@/utils/fs'
import settingState from '@/store/setting/state'
import log from './logger'

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

/**
 * 索引统一用 NFC 规范路径，但磁盘上的名字可能是等价的 NFD 形式。
 *
 * Android 上 `ほ`（U+307C）与 `ほ+゙`（U+307B U+3099）是两个不同的文件，
 * 且 NFC/NFD 可以**逐段混合**，所以必须逐段解析：每段先找 NFC 写法，
 * 找不到再找 NFD 写法。目录列表按目录缓存，避免每片都重新列目录。
 */
const dirNameCache = new Map<string, string[]>()

const readDirNames = async(dir: string): Promise<string[]> => {
  const cached = dirNameCache.get(dir)
  if (cached) return cached
  let names: string[] = []
  try {
    names = (await readDir(dir)).map(entry => entry.name)
  } catch {
    names = []
  }
  if (dirNameCache.size > 512) dirNameCache.clear()
  dirNameCache.set(dir, names)
  return names
}

/** 按段解析出磁盘上真实存在的绝对路径；找不到返回 null */
const resolveExistingAbsPath = async(root: string, relPath: string): Promise<string | null> => {
  let current = trimEnd(root)
  for (const segment of canonicalizeRelPath(relPath).split('/')) {
    const names = await readDirNames(current)
    // 同一段可能以多种等价写法存在于磁盘上，按「字面 -> NFC -> NFD -> NFKC」依次匹配。
    // NFKC 用于兼容写法（例如半角 `!` 与全角 `！` 是两个不同的目录名）。
    const exact = names.includes(segment)
      ? segment
      : names.find(name => name.normalize('NFC') === segment)
        ?? names.find(name => name.normalize('NFD') === segment.normalize('NFD'))
        ?? names.find(name => name.normalize('NFKC') === segment.normalize('NFKC'))
        ?? null
    if (exact == null) return null
    current = `${current}/${exact}`
  }
  return current
}

/** 写入时统一用 NFC 名字，避免再产生新的等价写法 */
const toWriteAbsPath = (root: string, relPath: string) => toAbsPath(root, canonicalizeRelPath(relPath))

/** 该文件夹是否可能包含 scope 内的文件 */
const dirAllowed = (relDir: string, scope: readonly string[]) => {
  if (!scope.length) return true
  if (!relDir.length) return true
  return scope.some(folder => relDir === folder || relDir.startsWith(folder + '/') || folder.startsWith(relDir + '/'))
}

const readDirSafe = async(path: string) => {
  try {
    return await readDir(path)
  } catch (err: any) {
    log.warn('scan', `readDir failed path=${path} err=${err?.message ?? err}`)
    return []
  }
}

/**
 * 读取首尾各 `SIGNATURE_SAMPLE_BYTES` 字节算内容签名（取样范围见 `getSignatureRanges`）。
 *
 * 目的：发现「字节数相同但内容不同」的文件（例如把加密/混淆过的音频原地解密后
 * 字节数完全没变），这类文件只看 size 会被永远判为「已同步」。
 * 取样失败（例如路径里含 `%` 时 RNFS.read 会报 Invalid file path）时返回 undefined，
 * 该文件退回只比 size 的旧判定，不影响同步可用性。
 */
const readFileSignature = async(absPath: string, size: number): Promise<string | undefined> => {
  const { headLength, tailOffset, tailLength } = getSignatureRanges(size)
  if (!headLength && !tailLength) return undefined
  try {
    const head = headLength ? Buffer.from(await readFileSlice(absPath, 0, headLength), 'base64') : new Uint8Array()
    const tail = tailLength ? Buffer.from(await readFileSlice(absPath, tailOffset, tailLength), 'base64') : new Uint8Array()
    return buildSignature(size, head, tail)
  } catch (err: any) {
    log.warn('scan', `signature failed path=${absPath} err=${err?.message ?? err}`)
    return undefined
  }
}

/** 扫描 scope 内所有文件夹下的音频与歌词文件 */
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
      const isAudio = isAudioFileName(name)
      if (!isAudio && !isLyricFileName(name)) continue
      const size = file.size ?? 0
      const entry: ScanEntry = { path: relPath, size, mtime: file.lastModified ?? 0 }
      // 音频才算内容签名：歌词是伴生文件，不参与内容比对
      if (isAudio) entry.sig = await readFileSignature(file.path, size)
      entries.push(entry)
    }
  }
  await walk(root, '', 0)
  return entries
}

export const scanIndex = async(root: string, scope: readonly string[] = getScope()): Promise<FileIndex> => {
  if (!root) throw new Error('未设置同步歌曲存放路径')
  log.info('scan', `root=${root} scope=${JSON.stringify(scope)}`)
  const entries = await scanEntries(root, scope)
  const index = buildIndex(entries)
  log.info('scan', `done root=${root} entries=${entries.length} folders=${index.folders.length} files=${index.files.length}`)
  return index
}

/** 扫描根目录下的文件夹树，附带音频数量，用于同步范围选择 */
export const scanFolderTree = async(root: string): Promise<LX.Sync.MusicFile.FolderNode[]> => {
  log.info('scanTree', `root=${root}`)
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
  const tree = await build(root, '')
  log.info('scanTree', `done root=${root} folders=${tree.length}`)
  return tree
}

/**
 * 读取失败时尽量还原现场：文件是否还在、父目录有什么、目录名是否只是“看起来一样”。
 * 这类信息是排查 ENOENT（路径对不上）最关键的证据。
 */
const describeReadFailure = async(absPath: string, root: string, relPath: string) => {
  const relDir = getRelDir(relPath)
  const absDir = relDir ? `${trimEnd(root)}/${relDir}` : trimEnd(root)
  const parts: string[] = [
    `root=${root}`,
    `relPath=${relPath}`,
    `absPath=${absPath}`,
    `rootExists=${await rootExists(root)}`,
    `parentDir=${absDir}`,
  ]
  try {
    parts.push(`parentDirExists=${await existsFile(absDir)}`)
  } catch (err: any) {
    parts.push(`parentDirExists=ERR(${err?.message ?? err})`)
  }
  // 父目录的真实内容：能直接看出是“文件夹没了”还是“文件名不一样”
  const siblings = await readDirSafe(absDir)
  parts.push(`parentEntryCount=${siblings.length}`)
  parts.push(`parentEntries=${JSON.stringify(siblings.slice(0, 50).map(item => item.name))}`)
  return parts.join(' ')
}

/**
 * 读取一个 base64 分片。
 *
 * 两个约束必须同时满足，这里用「先拷到私有缓存、再做真正的分片读」来兼顾：
 *
 * 1. **不能整文件读进内存**。同步的是无损音源，单个 70MB+ 很常见，
 *    整读会在 JS 堆里留下 base64 字符串 + Buffer（约 2.7 倍体积），直接 OOM 崩溃。
 * 2. **react-native-fs 的 `RNFS.read` 不能直接吃原始路径**。它内部把普通路径包成
 *    `file://` URI 再交给 `contentResolver.openInputStream()`，Android 对这种 URI 会抛
 *    `FileNotFoundException("Invalid file path")`（表现为 `ENOENT: Invalid file path`），
 *    即使文件确实存在。用户目录里的 `%`、空格等字符正是触发点。
 *
 * 因此：用扫描同源的 `FileSystem.cp`（原生 FileInputStream 直读，已证明能读这些文件）
 * 把文件复制到应用私有缓存下的纯 ASCII 路径，再用 `RNFS.read` 对副本做真正的偏移读取。
 * 内存占用恒定在一个分片大小，与文件体积无关；副本每个文件只拷一次，分片共用。
 */
const READ_COPY_THRESHOLD = 4 * 1024 * 1024

/** 当前已复制的临时副本（同一时刻只同步一个文件） */
let tempCopy: { src: string, size: number, tmp: string } | null = null

const tempCopyPath = (absPath: string) => {
  const name = absPath.slice(absPath.lastIndexOf('/') + 1)
  const extIndex = name.lastIndexOf('.')
  const ext = extIndex > 0 ? name.slice(extIndex + 1).replace(/[^A-Za-z0-9]/g, '').slice(0, 8) : ''
  return `${temporaryDirectoryPath}/mfs_read_tmp${ext ? '.' + ext : ''}`
}

/** 丢掉临时副本（同步结束或切换到别的文件时调用） */
export const releaseReadCache = async() => {
  const current = tempCopy
  tempCopy = null
  if (!current) return
  try {
    await unlink(current.tmp)
  } catch {}
}

/** 取得可直接分片读取的路径：小文件直读原路径，大文件先做一次副本 */
const getReadablePath = async(absPath: string, total: number): Promise<string> => {
  if (total <= READ_COPY_THRESHOLD) return absPath
  if (tempCopy && tempCopy.src === absPath && tempCopy.size === total) return tempCopy.tmp
  const tmp = tempCopyPath(absPath)
  // 换文件时先把上一个副本删掉，避免缓存目录堆积
  await releaseReadCache()
  try {
    if (await existsFile(tmp)) await unlink(tmp)
  } catch {}
  await copyFile(absPath, tmp)
  const info = await stat(tmp)
  const copied = info.size ?? 0
  if (copied !== total) {
    log.warn('read', `temp copy size mismatch src=${absPath} expect=${total} got=${copied}`)
  }
  const next = { src: absPath, size: total, tmp }
  // 断言安全：分片读取在单条 for 循环里顺序推进，不存在并发读，不会基于过期值覆盖
  // eslint-disable-next-line require-atomic-updates
  tempCopy = next
  log.info('read', `temp copy ready src=${absPath} bytes=${copied} tmp=${tmp}`)
  return tmp
}

/** 逐段解析出磁盘上真实存在的路径，并取回其大小 */
const statExisting = async(root: string, relPath: string): Promise<{ absPath: string, total: number }> => {
  const resolved = await resolveExistingAbsPath(root, relPath)
  const target = resolved ?? toAbsPath(root, relPath)
  const info = await stat(target)
  return { absPath: target, total: info.size ?? 0 }
}

export const readFileChunk = async(root: string, relPath: string, offset: number, size: number): Promise<LX.Sync.MusicFile.ReadFileResult> => {
  let absPath: string
  let total: number
  try {
    ({ absPath, total } = await statExisting(root, relPath))
  } catch (err: any) {
    log.err('read', `stat failed: ${await describeReadFailure(toAbsPath(root, relPath), root, relPath)} err=${err?.message ?? err}`)
    throw err
  }
  const start = Math.max(0, Math.min(offset, total))
  const length = Math.max(0, Math.min(size, total - start))
  let data = ''
  let source = absPath
  if (length > 0) {
    try {
      source = await getReadablePath(absPath, total)
      data = await readFileSlice(source, start, length)
    } catch (err: any) {
      log.err('read', `read failed: offset=${start} length=${length} size=${total} via=${source} ${await describeReadFailure(absPath, root, relPath)} err=${err?.message ?? err}`)
      throw err
    }
  }
  log.info('read', `ok relPath=${relPath} absPath=${absPath} offset=${start} length=${length} total=${total} viaTemp=${source !== absPath} eof=${start + length >= total}`)
  return { data, eof: start + length >= total }
}

/**
 * 写入一个 base64 分片：offset 为 0 时重建文件，之后顺序追加。
 *
 * Android 的单个路径名上限是 255 字节（UTF-8），日文/中文长标题很容易超过，
 * 直接写入会抛 ENAMETOOLONG 让整个文件同步失败。因此落盘时统一压限：
 * 名字取自原始全名的短哈希，所以同名文件在任何一次同步里都得到同一个名字。
 */
export const writeFileChunk = async(root: string, relPath: string, offset: number, data: string, isLast: boolean) => {
  const outRelPath = shortenRelPath(canonicalizeRelPath(relPath))
  const absPath = toWriteAbsPath(root, outRelPath)
  if (offset === 0) {
    const index = absPath.lastIndexOf('/')
    if (index > 0) {
      const dir = absPath.substring(0, index)
      try {
        if (!await existsFile(dir)) await mkdir(dir)
      } catch (err: any) {
        log.err('write', `mkdir failed dir=${dir} relPath=${outRelPath} err=${err?.message ?? err}`)
        throw err
      }
    }
    try {
      await writeFile(absPath, data, 'base64')
    } catch (err: any) {
      log.err('write', `writeFile failed: ${await describeReadFailure(absPath, root, outRelPath)} err=${err?.message ?? err}`)
      throw err
    }
    log.info('write', `create relPath=${outRelPath} bytes=${data.length} isLast=${isLast}`)
    return
  }
  try {
    await appendFile(absPath, data, 'base64')
  } catch (err: any) {
    log.err('write', `appendFile failed: offset=${offset} ${await describeReadFailure(absPath, root, outRelPath)} err=${err?.message ?? err}`)
    throw err
  }
  log.info('write', `append relPath=${outRelPath} offset=${offset} bytes=${data.length} isLast=${isLast}`)
}

/**
 * 删除文件；withLyric 为真时同时删除伴生 .lrc
 *
 * 磁盘上的名字可能是 NFD，且各段形式可混合，因此逐段解析；
 * 解析不到时再补一次「整条转 NFD」的兜底，避免留下残file。
 */
export const deleteFileWithLyric = async(root: string, relPath: string, withLyric: boolean) => {
  const outRelPath = shortenRelPath(canonicalizeRelPath(relPath))
  log.info('delete', `relPath=${outRelPath} withLyric=${withLyric}`)
  const targets = [outRelPath]
  if (withLyric) targets.push(shortenRelPath(canonicalizeRelPath(getLyricRelPath(relPath))))
  for (const target of targets) {
    const resolved = await resolveExistingAbsPath(root, target)
    if (resolved) await removeIfExists(resolved)
    else {
      await removeIfExists(toAbsPath(root, target))
      await removeIfExists(toAbsPath(root, target.split('/').map(segment => segment.normalize('NFD')).join('/')))
    }
  }
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

const removeIfExists = async(absPath: string) => {
  try {
    await unlink(absPath)
  } catch {}
}
