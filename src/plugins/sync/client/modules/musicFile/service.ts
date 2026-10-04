import {
  buildActions,
  buildPlan,
  MUSIC_FILE_CHUNK_SIZE,
} from './diff'
import * as localFs from './localFs'
import { getSocket } from '../../client'

/** 本地音乐文件同步只需要这几个远端方法 */
interface MusicFilePeer {
  musicFile_get_root: () => Promise<string>
  musicFile_get_index: () => Promise<LX.Sync.MusicFile.FileIndex>
  musicFile_read_file: (path: string, offset: number, size: number) => Promise<LX.Sync.MusicFile.ReadFileResult>
  musicFile_write_file: (path: string, offset: number, data: string, isLast: boolean) => Promise<void>
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
})

export const isRunning = () => running

const requirePeer = async() => {
  if (running) throw new Error('同步正在进行中')
  const socket = getSocket()
  if (!socket?.isReady || !socket.moduleReadys?.musicFile) throw new Error('未连接到对端设备，或对端版本不支持本地音乐文件同步')
  const root = localFs.getRootPath()
  if (!root) throw new Error('未设置同步歌曲存放路径')
  if (!await localFs.rootExists(root)) throw new Error('同步歌曲存放路径不存在')
  return { peer: socket.remote as MusicFilePeer, root }
}

/** 扫描两端并生成变更清单 */
export const compare = async(): Promise<LX.Sync.MusicFile.CompareResult> => {
  const { peer, root } = await requirePeer()
  const socket = getSocket()
  running = true
  updateProgress({ ...createProgress(), running: true, stage: 'comparing', message: '正在扫描本地文件…' })
  try {
    const localIndex = await localFs.scanIndex(root)
    updateProgress({ message: '正在读取对端文件列表…' })
    const remoteRoot = await peer.musicFile_get_root()
    if (!remoteRoot) throw new Error('对端未设置同步歌曲存放路径')
    const remoteIndex = await peer.musicFile_get_index()
    const plan = buildPlan(localIndex, remoteIndex)
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
}

const transferUploadFile = async(peer: MusicFilePeer, root: string, relPath: string, onBytes: (bytes: number) => void) => {
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
}

/** base64 字符串对应的原始字节数（android 端的 base64 不带换行） */
const base64Size = (data: string) => {
  if (!data) return 0
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.floor(data.length / 4) * 3 - padding
}

/** 执行用户在清单中勾选的传输动作 */
export const apply = async(selection: LX.Sync.MusicFile.Selection): Promise<LX.Sync.MusicFile.ApplyResult> => {
  const { peer, root } = await requirePeer()
  running = true
  cancelled = false
  const result: LX.Sync.MusicFile.ApplyResult = { downloaded: 0, uploaded: 0, errors: [] }
  try {
    updateProgress({ ...createProgress(), running: true, stage: 'comparing', message: '正在重新核对文件列表…' })
    const localIndex = await localFs.scanIndex(root)
    const remoteRoot = await peer.musicFile_get_root()
    if (!remoteRoot) throw new Error('对端未设置同步歌曲存放路径')
    const remoteIndex = await peer.musicFile_get_index()
    const plan = buildPlan(localIndex, remoteIndex)
    const actions = buildActions(plan, selection.checked)
    const totalBytes = actions.reduce((sum, action) => sum + action.size, 0)

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

    for (let index = 0; index < actions.length; index++) {
      const action = actions[index]
      updateProgress({ actionIndex: index + 1, kind: action.kind, path: action.path, fileBytes: 0 })
      try {
        switch (action.kind) {
          case 'download':
            await transferDownloadFile(peer, root, action.path, (bytes) => {
              doneBytes += bytes
              updateProgress({ fileBytes: progress.fileBytes + bytes, doneBytes })
            })
            result.downloaded++
            break
          case 'upload':
            await transferUploadFile(peer, root, action.path, (bytes) => {
              doneBytes += bytes
              updateProgress({ fileBytes: progress.fileBytes + bytes, doneBytes })
            })
            result.uploaded++
            break
        }
      } catch (err: any) {
        if (cancelled) throw err
        result.errors.push(`${action.path}: ${err?.message ?? err}`)
        updateProgress({ errors: [...result.errors] })
      }
    }

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
  }
}

export const cancel = () => {
  if (!running) return
  cancelled = true
  updateProgress({ message: '正在取消…' })
}

/** 协议：返回本机根目录（供对端展示） */
export const getRoot = () => localFs.getRootPath()

/** 协议：扫描本机索引 */
export const getIndex = async() => localFs.scanIndex(localFs.getRootPath())

/** 协议：读取本机文件分片 */
export const readChunk = async(relPath: string, offset: number, size: number) => localFs.readFileChunk(localFs.getRootPath(), relPath, offset, size)

/** 协议：写入本机文件分片 */
export const writeChunk = async(relPath: string, offset: number, data: string, isLast: boolean) => {
  await localFs.writeFileChunk(localFs.getRootPath(), relPath, offset, data, isLast)
}
