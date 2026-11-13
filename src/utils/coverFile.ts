// 同名封面文件规则（只写歌曲同目录同名 jpg/png，不内嵌、不改音频）
//
// 严格平移桌面 `src/main/modules/coverMatch/coverFile.ts` 的行为：
// - 只接受 JPEG(`FF D8 FF`) / PNG(`89 50 4E 47 0D 0A 1A 0A`)
// - 宽高 200–4000px，体积 ≤ 8MB
// - 写入目标扩展名：JPEG → `.jpg`，PNG → `.png`
// - 覆盖前先备份为 `.bak`（只保留第一次的原始备份）；`.tmp` + rename 原子写
// - 目标扩展名与另一扩展名的旧图都要处理，避免旧 jpg 遮住新 png
// - 回退：把 `.bak` 原子写回原图，成功后删除 `.bak`
//
// 注意：`@/utils/fs` 的 `rename(path, name)` 是**同目录改名**语义（第二个参数是文件名）。
import {
  existsFile,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from '@/utils/fs'
import { log } from '@/utils/log'
import { checkWritableLocalPath, type WritablePathCheckResult } from '@/utils/localPathCheck'
import {
  CoverImageError,
  validateImageData,
  type ImageFormat,
  type ImageInfo,
} from '@/utils/coverMatch/image'

export type CoverFileErrorCode =
  | 'invalid_file'
  | 'image_invalid'
  | 'image_too_large'
  | 'no_permission'
  | 'disk_full'
  | 'unknown'

export class CoverFileError extends Error {
  code: CoverFileErrorCode

  constructor(code: CoverFileErrorCode, message: string) {
    super(message)
    this.name = 'CoverFileError'
    this.code = code
  }
}

const IMAGE_FORMATS: ImageFormat[] = ['jpg', 'png']

const audioExtRxp = /\.(?:lrc|bak|tmp|jpg|jpeg|png|webp)$/i

const getFileName = (filePath: string): string => {
  const dirIndex = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return filePath.substring(dirIndex + 1)
}

const getExtname = (filePath: string): string => {
  const name = getFileName(filePath)
  const dotIndex = name.lastIndexOf('.')
  return dotIndex > 0 ? name.substring(dotIndex) : ''
}

const statOrNull = async(filePath: string) => {
  try {
    return await stat(filePath)
  } catch {
    return null
  }
}

const getErrnoCode = (err: unknown): string => {
  return (err as { code?: string } | null)?.code ?? ''
}

const getErrorMessage = (err: unknown): string => {
  return err instanceof Error ? err.message : String(err)
}

const classifyError = (err: unknown): CoverFileErrorCode => {
  if (err instanceof CoverFileError) return err.code
  switch (getErrnoCode(err)) {
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return 'no_permission'
    case 'ENOSPC':
      return 'disk_full'
    default:
      break
  }
  const message = getErrorMessage(err)
  if (/EACCES|EPERM|EROFS|permission|read-only|readonly/i.test(message)) return 'no_permission'
  if (/ENOSPC|no space|disk full|space left|空间不足/i.test(message)) return 'disk_full'
  return 'unknown'
}

const toCoverFileError = (err: unknown): CoverFileError => {
  if (err instanceof CoverFileError) return err
  // 图片错误码原样透传
  if (err instanceof CoverImageError) return new CoverFileError(err.code, err.message)
  return new CoverFileError(classifyError(err), getErrorMessage(err))
}

const removeIfExists = async(filePath: string): Promise<void> => {
  await unlink(filePath).catch(() => {})
}

const unlinkIfExists = async(filePath: string): Promise<void> => {
  if (await existsFile(filePath).catch(() => false)) await unlink(filePath)
}

/**
 * 同目录改名（`rename(path, name)` 的 name 只能是不含目录的文件名）
 */
const renameTo = async(fromPath: string, toPath: string): Promise<boolean> => {
  return rename(fromPath, getFileName(toPath))
}

const moveFile = async(fromPath: string, toPath: string): Promise<void> => {
  if (!await renameTo(fromPath, toPath)) throw new Error(`rename file failed: ${fromPath} -> ${toPath}`)
}

/**
 * 目标已存在且平台不允许 rename 覆盖时：先 unlink 再重试一次（同 lrcFile 的做法）
 */
const renameWithOverwriteRetry = async(fromPath: string, toPath: string): Promise<void> => {
  let renamed = await renameTo(fromPath, toPath)
  if (!renamed && await existsFile(toPath)) {
    await unlink(toPath).catch(() => {})
    if (!await existsFile(toPath)) renamed = await renameTo(fromPath, toPath)
  }
  if (!renamed) throw new Error(`rename temp file failed: ${fromPath}`)
}

/**
 * 判断路径能否写回同名封面（与一期 `checkLrcMatchablePath` 规则一致）
 */
export const checkCoverMatchablePath = (filePath?: string | null): WritablePathCheckResult => {
  return checkWritableLocalPath(filePath)
}

/**
 * 由音频路径推导同名图片路径（小写扩展名）
 */
export const getImagePath = (filePath: string, format: ImageFormat): string => {
  const ext = getExtname(filePath)
  const stem = ext ? filePath.slice(0, filePath.length - ext.length) : filePath
  return `${stem}.${format}`
}

export const getCoverBackupPath = (filePath: string, format: ImageFormat): string => {
  return getImagePath(filePath, format) + '.bak'
}

const getOtherFormat = (format: ImageFormat): ImageFormat => {
  return format === 'jpg' ? 'png' : 'jpg'
}

/**
 * 仅允许真实存在、带扩展名、非歌词/备份/临时/图片的绝对文件路径
 */
export const isAudioFilePath = async(filePath: string): Promise<boolean> => {
  if (!filePath || typeof filePath !== 'string' || !filePath.startsWith('/')) return false
  if (!getExtname(filePath) || audioExtRxp.test(filePath)) return false
  const audioStats = await statOrNull(filePath)
  return !!audioStats?.isFile
}

/**
 * 查询已存在的同名封面（读取优先 jpg，再 png）；返回路径与 mtime
 */
export const getCoverImagePathIfExists = async(
  filePath: string,
): Promise<{ path: string, format: ImageFormat, mtime: number } | null> => {
  for (const format of IMAGE_FORMATS) {
    const imagePath = getImagePath(filePath, format)
    const imageStats = await statOrNull(imagePath)
    if (imageStats?.isFile) return { path: imagePath, format, mtime: imageStats.lastModified }
  }
  return null
}

/**
 * 查询同名封面 / 备份状态；读取规则：优先 jpg，再 png
 */
export const getCoverState = async(filePath: string): Promise<LX.Music.CoverState> => {
  if (!await isAudioFilePath(filePath)) return { imageExists: false, backupExists: false }

  const [jpgStats, pngStats, jpgBackupStats, pngBackupStats] = await Promise.all([
    statOrNull(getImagePath(filePath, 'jpg')),
    statOrNull(getImagePath(filePath, 'png')),
    statOrNull(getCoverBackupPath(filePath, 'jpg')),
    statOrNull(getCoverBackupPath(filePath, 'png')),
  ])

  const format: ImageFormat | undefined = jpgStats?.isFile ? 'jpg' : pngStats?.isFile ? 'png' : undefined
  const imageStats = format === 'jpg' ? jpgStats : format === 'png' ? pngStats : null

  const state: LX.Music.CoverState = {
    imageExists: !!format,
    backupExists: (jpgBackupStats?.isFile ?? false) || (pngBackupStats?.isFile ?? false),
  }
  if (format && imageStats) {
    state.imagePath = getImagePath(filePath, format)
    state.imageFormat = format
    state.imageSize = imageStats.size
    state.imageMtime = imageStats.lastModified
  }
  return state
}

interface CreatedBackup {
  originalPath: string
  backupPath: string
}

interface StagedImage {
  originalPath: string
  stagedPath: string
}

const toBase64 = (data: Uint8Array): string => Buffer.from(data).toString('base64')

/**
 * 写入同名封面：先备份（只保留第一次的原始备份）→ `.tmp` + rename 原子写；失败恢复备份
 *
 * 若另一扩展名的旧图存在但其 `.bak` 已存在（无法再备份），先把旧图暂存为
 * `<image>.bak.replaced.tmp`，写入成功后删除、失败则改回原名，避免旧图遮住新图。
 */
export const applyCoverImage = async(
  filePath: string,
  data: Uint8Array,
): Promise<LX.Music.CoverApplyResult> => {
  if (!await isAudioFilePath(filePath)) {
    throw new CoverFileError('invalid_file', 'invalid audio file path')
  }
  let info: ImageInfo
  try {
    info = validateImageData(data)
  } catch (err) {
    throw toCoverFileError(err)
  }

  const targetPath = getImagePath(filePath, info.format)
  const otherPath = getImagePath(filePath, getOtherFormat(info.format))
  const tmpPath = `${targetPath}.tmp`
  const createdBackups: CreatedBackup[] = []
  const stagedImages: StagedImage[] = []
  let backupCreated = false

  try {
    // 目标扩展名与另一扩展名的旧图都要处理，避免出现「旧 jpg 遮住新 png」
    for (const imagePath of [targetPath, otherPath]) {
      const imageStats = await statOrNull(imagePath)
      if (!imageStats?.isFile) continue
      const backupPath = `${imagePath}.bak`
      if (await statOrNull(backupPath)) {
        // 目标扩展名的旧图稍后会被直接覆盖，保留旧 .bak 即可
        if (imagePath === targetPath) continue
        // 另一扩展名无法再备份：先暂存移走，保证新图可见
        const stagedPath = `${imagePath}.bak.replaced.tmp`
        await removeIfExists(stagedPath)
        await moveFile(imagePath, stagedPath)
        stagedImages.push({ originalPath: imagePath, stagedPath })
        continue
      }
      await moveFile(imagePath, backupPath)
      createdBackups.push({ originalPath: imagePath, backupPath })
      backupCreated = true
    }

    await removeIfExists(tmpPath)
    await writeFile(tmpPath, toBase64(data), 'base64')
    await renameWithOverwriteRetry(tmpPath, targetPath)

    // 写入成功后才清理暂存的旧图
    for (const staged of stagedImages) await removeIfExists(staged.stagedPath)

    return { imagePath: targetPath, format: info.format, backupCreated }
  } catch (err) {
    await removeIfExists(tmpPath)
    // 写入失败：把本次刚备份的旧图改回原名（已有 .bak 的保持不动）
    for (const backup of createdBackups.reverse()) {
      try {
        if (!await statOrNull(backup.originalPath)) await moveFile(backup.backupPath, backup.originalPath)
      } catch (restoreErr) {
        log.warn(`restore cover backup failed: ${backup.backupPath}`, restoreErr)
      }
    }
    // 写入失败：把暂存的旧图改回原名
    for (const staged of stagedImages.reverse()) {
      try {
        if (!await statOrNull(staged.originalPath)) await moveFile(staged.stagedPath, staged.originalPath)
      } catch (restoreErr) {
        log.warn(`restore staged cover failed: ${staged.stagedPath}`, restoreErr)
      }
      await removeIfExists(staged.stagedPath)
    }
    throw toCoverFileError(err)
  }
}

interface RollbackBackup {
  format: ImageFormat
  imagePath: string
  backupPath: string
}

/**
 * 回退：把 `.bak` 原子写回原图，成功后删除 `.bak`；失败不丢当前图，可重试
 *
 * 若当前可见图是本次匹配新生成、且该扩展名没有备份（说明原来不存在），
 * 先把它临时移开，恢复备份后再删除，避免「新图遮住恢复的原图」。
 */
export const rollbackCover = async(filePath: string): Promise<boolean> => {
  if (!await isAudioFilePath(filePath)) {
    throw new CoverFileError('invalid_file', 'invalid audio file path')
  }

  const backups: RollbackBackup[] = []
  for (const format of IMAGE_FORMATS) {
    const backupPath = getCoverBackupPath(filePath, format)
    if (await statOrNull(backupPath)) {
      backups.push({ format, imagePath: getImagePath(filePath, format), backupPath })
    }
  }
  if (!backups.length) return false

  const state = await getCoverState(filePath)
  const currentFormat = state.imageFormat
  const currentBackedUp = currentFormat != null && backups.some(item => item.format === currentFormat)
  const stagedNewImage = currentFormat && !currentBackedUp ? state.imagePath ?? null : null
  const stagedNewPath = stagedNewImage ? `${stagedNewImage}.rollback.tmp` : null

  if (stagedNewImage && stagedNewPath) {
    try {
      await removeIfExists(stagedNewPath)
      await moveFile(stagedNewImage, stagedNewPath)
    } catch (err) {
      throw toCoverFileError(err)
    }
  }

  try {
    for (const item of backups) {
      const backupData = await readFile(item.backupPath, 'base64')
      const rollbackTmpPath = `${item.imagePath}.rollback.tmp`
      await removeIfExists(rollbackTmpPath)
      await writeFile(rollbackTmpPath, backupData, 'base64')
      await renameWithOverwriteRetry(rollbackTmpPath, item.imagePath)
    }
    for (const item of backups) await unlinkIfExists(item.backupPath)
    if (stagedNewPath) await unlinkIfExists(stagedNewPath)
    return true
  } catch (err) {
    for (const item of backups) await removeIfExists(`${item.imagePath}.rollback.tmp`)
    // 恢复暂存的新图：若对应路径已被恢复的备份占用则放弃（备份才是原图）
    if (stagedNewImage && stagedNewPath) {
      try {
        if (!await statOrNull(stagedNewImage)) await moveFile(stagedNewPath, stagedNewImage)
      } catch (restoreErr) {
        log.warn(`restore staged cover failed: ${stagedNewPath}`, restoreErr)
      }
      await removeIfExists(stagedNewPath)
    }
    throw toCoverFileError(err)
  }
}
