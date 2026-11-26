import { existsFile, rename, stat, unlink } from './fs'

const pendingWrites = new Map<string, Promise<unknown>>()

// 同名文件的写入和删除按调用顺序执行。
export const withSidecarWrite = async<T>(filePath: string, write: () => Promise<T>): Promise<T> => {
  const previous = pendingWrites.get(filePath)
  const current = previous ? previous.catch(() => {}).then(write) : write()
  pendingWrites.set(filePath, current)
  try {
    return await current
  } finally {
    if (pendingWrites.get(filePath) === current) pendingWrites.delete(filePath)
  }
}

export const unlinkSidecar = async(filePath: string): Promise<boolean> => {
  if (!await existsFile(filePath)) return false
  const info = await stat(filePath).catch((error: unknown) => {
    if ((error as { code?: string })?.code === 'ENOENT') return null
    throw error
  })
  // 原生 unlink 会递归删除目录，并且删除失败时可能仍返回成功。
  if (!info?.isFile) return false
  await unlink(filePath)
  if (await existsFile(filePath)) throw new Error(`Permission denied: unable to delete ${filePath}`)
  return true
}

export const replaceSidecar = async(tmpPath: string, filePath: string): Promise<void> => {
  const name = filePath.slice(filePath.lastIndexOf('/') + 1)
  if (await rename(tmpPath, name)) return
  // 部分文件系统要求先移除旧文件才能改名。
  if (await unlinkSidecar(filePath) && await rename(tmpPath, name)) return
  throw new Error(`rename temp file failed: ${tmpPath}`)
}
