import { stat, writeFile } from '@/utils/fs'
import { replaceSidecar, unlinkSidecar, withSidecarWrite } from './sidecarWrite'
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

const audioExtRxp = /\.(?:lrc|krc|bak|tmp|jpg|jpeg|png|webp)$/i

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

export const getCoverState = async(filePath: string): Promise<LX.Music.CoverState> => {
  if (!await isAudioFilePath(filePath)) return { imageExists: false }
  for (const format of IMAGE_FORMATS) {
    const imagePath = getImagePath(filePath, format)
    const stats = await statOrNull(imagePath)
    if (stats?.isFile) {
      return { imageExists: true, imagePath, imageFormat: format, imageSize: stats.size, imageMtime: stats.lastModified }
    }
  }
  return { imageExists: false }
}

export const applyCoverImage = async(filePath: string, data: Uint8Array): Promise<LX.Music.CoverApplyResult> => {
  if (!await isAudioFilePath(filePath)) {
    throw new CoverFileError('invalid_file', 'invalid audio file path')
  }
  let info: ImageInfo
  try {
    info = validateImageData(data)
  } catch (err) {
    throw toCoverFileError(err)
  }
  const { format } = info
  const jpgPath = getImagePath(filePath, 'jpg')
  const pngPath = getImagePath(filePath, 'png')
  const imagePath = format === 'jpg' ? jpgPath : pngPath
  const otherPath = format === 'jpg' ? pngPath : jpgPath

  return withSidecarWrite(jpgPath, async() => {
    const tmpPath = imagePath + '.tmp'
    try {
      await unlinkSidecar(tmpPath)
      await writeFile(tmpPath, Buffer.from(data).toString('base64'), 'base64')
      await replaceSidecar(tmpPath, imagePath)
      await unlinkSidecar(otherPath)
      return { imagePath, format }
    } catch (err) {
      throw toCoverFileError(err)
    } finally {
      await unlinkSidecar(tmpPath).catch(() => {})
    }
  })
}

export const deleteCover = async(filePath: string): Promise<boolean> => {
  if (!await isAudioFilePath(filePath)) {
    throw new CoverFileError('invalid_file', 'invalid audio file path')
  }

  const jpgPath = getImagePath(filePath, 'jpg')
  return withSidecarWrite(jpgPath, async() => {
    try {
      const deleted = await unlinkSidecar(jpgPath)
      return await unlinkSidecar(getImagePath(filePath, 'png')) || deleted
    } catch (err) {
      throw toCoverFileError(err)
    }
  })
}
