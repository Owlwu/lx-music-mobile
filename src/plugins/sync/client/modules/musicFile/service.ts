import { normalizeScope } from './diff'
import * as localFs from './localFs'
import log from './logger'

/**
 * 本地音乐文件同步 —— 手机端只实现「对端 RPC」这一半
 *
 * 同步一律由 PC 端发起（PC 扫描两端、生成变更清单、决定传输方向），手机端作为对端提供：
 * 根目录、按 scope 扫描出的索引、分片读写、删除。因此这里不存在 compare/apply，
 * 也没有进度状态与同步基线 —— 那些是「发起方」才需要的东西，全都留在 PC 端。
 */

/** 协议：返回本机根目录（供对端展示与校验） */
export const getRoot = () => localFs.getRootPath()

/** 协议：按对端指定的 scope 扫描本机索引 */
export const getIndex = async(scope: string[]) => {
  const root = localFs.getRootPath()
  log.info('rpc', `getIndex called by peer localRoot=${root} scope=${JSON.stringify(scope ?? [])}`)
  return localFs.scanIndex(root, normalizeScope(scope ?? []))
}

/**
 * 协议：读取本机文件分片
 *
 * 大文件会先复制到私有缓存再做分片读取（见 localFs.getReadablePath）。这份临时副本
 * 原先在「手机端自己发起同步」的 apply() 收尾时清理；那条链路已移除，
 * 于是改为在读到最后一片（eof）或读失败时立刻清掉，避免缓存目录残留大文件。
 */
export const readChunk = async(relPath: string, offset: number, size: number) => {
  const root = localFs.getRootPath()
  // 对端请求读取本机文件：这条日志能直接回答“到底是谁在找哪个文件”
  log.info('rpc', `readChunk called by peer relPath=${relPath} offset=${offset} size=${size} localRoot=${root}`)
  try {
    const chunk = await localFs.readFileChunk(root, relPath, offset, size)
    if (chunk.eof) await localFs.releaseReadCache()
    return chunk
  } catch (err) {
    await localFs.releaseReadCache()
    throw err
  }
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
