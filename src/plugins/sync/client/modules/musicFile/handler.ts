// 这个文件导出的方法将暴露给服务端调用，第一个参数固定为当前 socket 对象
import { getIndex, getRoot, readChunk, writeChunk } from './service'

/** 握手没有完成前拒绝一切文件读写，避免半握手状态被对端驱动 */
const assertReady = (socket: LX.Sync.Socket) => {
  if (!socket.moduleReadys?.musicFile) throw new Error('musicFile feature is not ready')
}

const handler: LX.Sync.ClientSyncHandlerMusicFileActions<LX.Sync.Socket> = {
  async musicFile_get_root(socket) {
    assertReady(socket)
    return getRoot()
  },

  async musicFile_get_index(socket, scope) {
    assertReady(socket)
    return getIndex(scope)
  },

  async musicFile_read_file(socket, path, offset, size) {
    assertReady(socket)
    return readChunk(path, offset, size)
  },

  async musicFile_write_file(socket, path, offset, data, isLast) {
    assertReady(socket)
    await writeChunk(path, offset, data, isLast)
  },

  async musicFile_sync_finished(socket) {
    socket.moduleReadys.musicFile = true
  },
}

export default handler
