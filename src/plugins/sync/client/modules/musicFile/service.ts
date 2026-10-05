import {
  buildActions,
  buildBaseline,
  buildPlan,
  MUSIC_FILE_CHUNK_SIZE,
  normalizeScope,
  type TransferAction,
} from './diff'
import * as localFs from './localFs'
import { getSocket } from '../../client'
import { getMusicFileSyncBaseline, saveMusicFileSyncBaseline } from '@/utils/data'
import log from './logger'

/** 本地音乐文件同步只需要这几个远端方法 */
interface MusicFilePeer {
  musicFile_get_root: () => Promise<string>
  musicFile_get_index: (scope: string[]) => Promise<LX.Sync.MusicFile.FileIndex>
  musicFile_read_file: (path: string, offset: number, size: number) => Promise<LX.Sync.MusicFile.ReadFileResult>
  musicFile_write_file: (path: string, offset: number, data: string, isLast: boolean) => Promise<void>
  musicFile_delete_file: (path: string, withLyric: boolean) => Promise<void>
}

const createProgress = (): LX.Sync.MusicFile.Progress => ({
  running: false,
  stage: 'idle',
  kind: '',
  path: '',
  actionIndex: 0,
  actionTotal: 0,
  fileBytes: 0,
  fileBytesTotal: 0,
  totalBytes: 0,
  doneBytes: 0,
  message: '',
  errors: [],
})

let progress = createProgress()
let running = false
let cancelled = false
let progressListener: ((progress: LX.Sync.MusicFile.Progress) => void) | null = null

export const setProgressListener = (listener: ((progress: LX.Sync.MusicFile.Progress) => void) | null) => {
  progressListener = listener
}

const updateProgress = (patch: Partial<LX.Sync.MusicFile.Progress>) => {
  progress = { ...progress, ...patch }
  progressListener?.({ ...progress })
}

export const getProgress = () => ({ ...progress })

export const getConfig = (): LX.Sync.MusicFile.Config => ({
  root: localFs.getRootPath(),
  scope: localFs.getScope(),
})

export const isRunning = () => running

const requirePeer = async() => {
  if (running) throw new Error('同步正在进行中')
  const socket = getSocket()
  if (!socket?.isReady || !socket.moduleReadys?.musicFile) throw new Error('未连接到对端设备，或对端版本不支持本地音乐文件同步')
  const root = localFs.getRootPath()
  if (!root) throw new Error('未设置同步歌曲存放路径')
  if (!await localFs.rootExists(root)) throw new Error('同步歌曲存放路径不存在')
  return { peer: socket.remote as MusicFilePeer, root, scope: normalizeScope(localFs.getScope()) }
}

/** 两端的诊断日志都带上根目录与 scope，便于直接对照 */
const describeSide = (root: string, scope: readonly string[]) => `root=${root} scope=${JSON.stringify(scope)}`

export const getFolders = async() => {
  const root = localFs.getRootPath()
  if (!root) throw new Error('未设置同步歌曲存放路径')
  if (!await localFs.rootExists(root)) throw new Error('同步歌曲存放路径不存在')
  return localFs.scanFolderTree(root)
}

/** 扫描两端并生成变更清单 */
export const compare = async(): Promise<LX.Sync.MusicFile.CompareResult> => {
  const { peer, root, scope } = await requirePeer()
  const socket = getSocket()
  running = true
  updateProgress({ ...createProgress(), running: true, stage: 'comparing', message: '正在扫描本地文件…' })
  try {
    log.info('compare', `start role=initiator local(${describeSide(root, scope)})`)
    const localIndex = await localFs.scanIndex(root, scope)
    updateProgress({ message: '正在读取对端文件列表…' })
    const remoteRoot = await peer.musicFile_get_root()
    if (!remoteRoot) throw new Error('对端未设置同步歌曲存放路径')
    const remoteIndex = await peer.musicFile_get_index(scope)
    log.info('compare', `remote(${describeSide(remoteRoot, scope)}) folders=${remoteIndex.folders.length} files=${remoteIndex.files.length}`)
    const baseline = await getMusicFileSyncBaseline()
    const plan = buildPlan(localIndex, remoteIndex, baseline)
    log.info('compare', `plan ${JSON.stringify(Object.fromEntries(Object.entries(plan).map(([k, v]) => [k, v.length])))} baseline=${baseline.length} localFiles=${localIndex.files.length} remoteFiles=${remoteIndex.files.length}`)
    return {
      plan,
      localRoot: root,
      remoteRoot,
      remoteDeviceName: socket?.data.keyInfo.serverName ?? '',
    }
  } finally {
    running = false
    updateProgress({ ...createProgress(), stage: 'idle', message: '' })
  }
}

const transferDownloadFile = async(peer: MusicFilePeer, root: string, relPath: string, onBytes: (bytes: number) => void) => {
  log.info('transfer', `download start relPath=${relPath} -> localRoot=${root}`)
  let offset = 0
  for (;;) {
    if (cancelled) throw new Error('已取消')
    const chunk = await peer.musicFile_read_file(relPath, offset, MUSIC_FILE_CHUNK_SIZE)
    const size = base64Size(chunk.data)
    await localFs.writeFileChunk(root, relPath, offset, chunk.data, chunk.eof)
    offset += size
    onBytes(size)
    if (chunk.eof || !size) break
  }
  log.info('transfer', `download done relPath=${relPath} bytes=${offset}`)
}

const transferUploadFile = async(peer: MusicFilePeer, root: string, relPath: string, onBytes: (bytes: number) => void) => {
  log.info('transfer', `upload start relPath=${relPath} from localRoot=${root}`)
  let offset = 0
  for (;;) {
    if (cancelled) throw new Error('已取消')
    const chunk = await localFs.readFileChunk(root, relPath, offset, MUSIC_FILE_CHUNK_SIZE)
    const size = base64Size(chunk.data)
    await peer.musicFile_write_file(relPath, offset, chunk.data, chunk.eof)
    offset += size
    onBytes(size)
    if (chunk.eof || !size) break
  }
  log.info('transfer', `upload done relPath=${relPath} bytes=${offset}`)
}

/** base64 字符串对应的原始字节数（android 端的 base64 不带换行） */
const base64Size = (data: string) => {
  if (!data) return 0
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.floor(data.length / 4) * 3 - padding
}

const lyricRelPath = (relPath: string) => {
  const index = relPath.lastIndexOf('.')
  return (index > 0 ? relPath.substring(0, index) : relPath) + '.lrc'
}

/** 按相对路径索引伴生歌词的大小，用于把歌词算进进度总量 */
const buildLyricSizeMap = (index: LX.Sync.MusicFile.FileIndex) => {
  const map = new Map<string, number>()
  for (const file of index.files) map.set(file.path, file.lyric?.size ?? 0)
  return map
}

/** 执行用户在清单中勾选的传输动作 */
export const apply = async(selection: LX.Sync.MusicFile.Selection): Promise<LX.Sync.MusicFile.ApplyResult> => {
  const { peer, root, scope } = await requirePeer()
  running = true
  cancelled = false
  const result: LX.Sync.MusicFile.ApplyResult = { downloaded: 0, uploaded: 0, deletedLocal: 0, deletedRemote: 0, errors: [] }
  try {
    updateProgress({ ...createProgress(), running: true, stage: 'comparing', message: '正在重新核对文件列表…' })
    log.info('apply', `start role=initiator local(${describeSide(root, scope)}) checked=${Object.keys(selection.checked ?? {}).length}`)
    const localIndex = await localFs.scanIndex(root, scope)
    const remoteRoot = await peer.musicFile_get_root()
    if (!remoteRoot) throw new Error('对端未设置同步歌曲存放路径')
    const remoteIndex = await peer.musicFile_get_index(scope)
    log.info('apply', `remote(${describeSide(remoteRoot, scope)}) folders=${remoteIndex.folders.length} files=${remoteIndex.files.length}`)
    const plan = buildPlan(localIndex, remoteIndex, await getMusicFileSyncBaseline())
    const actions = buildActions(plan, selection.checked, selection.direction)
    log.info('apply', `actions=${actions.length} ${JSON.stringify(actions.map(a => `${a.kind}:${a.path}`).slice(0, 30))}`)
    const localLyricSizes = buildLyricSizeMap(localIndex)
    const remoteLyricSizes = buildLyricSizeMap(remoteIndex)
    const totalBytes = actions.reduce((sum, action) => {
      if (!('size' in action)) return sum
      const lyricSizes = action.kind === 'download' ? remoteLyricSizes : localLyricSizes
      return sum + action.size + (action.hasLyric ? lyricSizes.get(action.path) ?? 0 : 0)
    }, 0)

    let doneBytes = 0
    updateProgress({
      running: true,
      stage: 'transferring',
      actionIndex: 0,
      actionTotal: actions.length,
      totalBytes,
      doneBytes: 0,
      errors: [],
      message: '',
    })

    const targetsOf = (action: TransferAction) => {
      const list = [action.path]
      if (action.hasLyric) list.push(lyricRelPath(action.path))
      return list
    }

    for (let index = 0; index < actions.length; index++) {
      const action = actions[index]
      updateProgress({ actionIndex: index + 1, kind: action.kind, path: action.path, fileBytes: 0 })
      try {
        switch (action.kind) {
          case 'download':
            for (const target of targetsOf(action)) {
              await transferDownloadFile(peer, root, target, (bytes) => {
                doneBytes += bytes
                updateProgress({ fileBytes: progress.fileBytes + bytes, doneBytes })
              })
            }
            result.downloaded++
            break
          case 'upload':
            for (const target of targetsOf(action)) {
              await transferUploadFile(peer, root, target, (bytes) => {
                doneBytes += bytes
                updateProgress({ fileBytes: progress.fileBytes + bytes, doneBytes })
              })
            }
            result.uploaded++
            break
          case 'delete_local':
            await localFs.deleteFileWithLyric(root, action.path, action.hasLyric)
            result.deletedLocal++
            break
          case 'delete_remote':
            await peer.musicFile_delete_file(action.path, action.hasLyric)
            result.deletedRemote++
            break
        }
      } catch (err: any) {
        if (cancelled) throw err
        // 记录失败动作的类型与目标，便于判断是“本地读”还是“远端读”出的问题
        log.err('apply', `action failed kind=${action.kind} path=${action.path} localRoot=${root} remoteRoot=${remoteRoot} err=${err?.message ?? err}`)
        result.errors.push(`${action.path}: ${err?.message ?? err}`)
        updateProgress({ errors: [...result.errors] })
      }
    }

    updateProgress({ stage: 'finishing', message: '正在更新同步基线…' })
    const finalLocal = await localFs.scanIndex(root, scope)
    const finalRemote = await peer.musicFile_get_index(scope)
    await saveMusicFileSyncBaseline(buildBaseline(finalLocal, finalRemote))
    log.info('apply', `done downloaded=${result.downloaded} uploaded=${result.uploaded} deletedLocal=${result.deletedLocal} deletedRemote=${result.deletedRemote} errors=${result.errors.length}`)

    updateProgress({
      running: false,
      stage: result.errors.length ? 'error' : 'done',
      kind: '',
      path: '',
      message: result.errors.length ? `同步已结束，但有 ${result.errors.length} 个文件失败` : '同步完成',
    })
    return result
  } finally {
    running = false
    // 出现意外异常时也要让界面上的进度条停下来
    if (progress.running) updateProgress({ running: false, stage: 'error' })
    // 大文件读取会在缓存目录留一份临时副本，同步结束就清掉
    await localFs.releaseReadCache()
  }
}

export const cancel = () => {
  if (!running) return
  cancelled = true
  updateProgress({ message: '正在取消…' })
}

/** 协议：返回本机根目录（供对端展示） */
export const getRoot = () => localFs.getRootPath()

/** 协议：按 scope 扫描本机索引 */
export const getIndex = async(scope: string[]) => {
  const root = localFs.getRootPath()
  log.info('rpc', `getIndex called by peer localRoot=${root} scope=${JSON.stringify(scope ?? [])}`)
  return localFs.scanIndex(root, normalizeScope(scope ?? []))
}

/** 协议：读取本机文件分片 */
export const readChunk = async(relPath: string, offset: number, size: number) => {
  // 对端请求读取本机文件：这条日志能直接回答“到底是谁在找哪个文件”
  log.info('rpc', `readChunk called by peer relPath=${relPath} offset=${offset} size=${size} localRoot=${localFs.getRootPath()}`)
  return localFs.readFileChunk(localFs.getRootPath(), relPath, offset, size)
}

/** 协议：写入本机文件分片 */
export const writeChunk = async(relPath: string, offset: number, data: string, isLast: boolean) => {
  log.info('rpc', `writeChunk called by peer relPath=${relPath} offset=${offset} isLast=${isLast} localRoot=${localFs.getRootPath()}`)
  await localFs.writeFileChunk(localFs.getRootPath(), relPath, offset, data, isLast)
}

/** 协议：删除本机文件 */
export const removeFile = async(relPath: string, withLyric: boolean) => {
  log.info('rpc', `deleteFile called by peer relPath=${relPath} withLyric=${withLyric} localRoot=${localFs.getRootPath()}`)
  await localFs.deleteFileWithLyric(localFs.getRootPath(), relPath, withLyric)
}
