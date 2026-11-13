// 封面图片 magic/尺寸解析与体积校验（纯函数，无平台依赖）
//
// 与桌面 `src/main/modules/coverMatch/coverFile.ts` 的图片解析部分保持一致：
// - 只认 JPEG(`FF D8 FF`，且能扫到 SOF) / PNG(8 字节签名 + IHDR 首块)
// - 宽高 200–4000（含边界），体积 ≤ 8MB；webp/gif/截断一律视为非法

export type ImageFormat = 'jpg' | 'png'

export interface ImageInfo {
  format: ImageFormat
  width: number
  height: number
}

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
export const MIN_IMAGE_DIMENSION = 200
export const MAX_IMAGE_DIMENSION = 4000

export type CoverImageErrorCode = 'image_invalid' | 'image_too_large'

export class CoverImageError extends Error {
  code: CoverImageErrorCode

  constructor(code: CoverImageErrorCode, message: string) {
    super(message)
    this.name = 'CoverImageError'
    this.code = code
  }
}

const isSofMarker = (marker: number): boolean => {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
}

const parseJpegInfo = (data: Uint8Array): ImageInfo | null => {
  // 跳过 SOI 后逐段扫描，遇到 SOF 段时读取宽高
  let offset = 2
  while (offset + 1 < data.length) {
    if (data[offset] !== 0xff) {
      offset++
      continue
    }
    let marker = data[offset + 1]
    while (marker === 0xff) {
      offset++
      if (offset + 1 >= data.length) return null
      marker = data[offset + 1]
    }
    offset += 2
    // 无长度字段的独立标记
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
    if (marker === 0xd9 || marker === 0xda) return null
    if (offset + 1 >= data.length) return null
    const length = (data[offset] << 8) | data[offset + 1]
    if (length < 2) return null
    if (isSofMarker(marker)) {
      // 段内容：精度(1) + 高(2) + 宽(2) + 分量数(1) + ...
      if (offset + 7 > data.length) return null
      const height = (data[offset + 3] << 8) | data[offset + 4]
      const width = (data[offset + 5] << 8) | data[offset + 6]
      if (!width || !height) return null
      return { format: 'jpg', width, height }
    }
    offset += length
  }
  return null
}

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const readUint32 = (data: Uint8Array, offset: number): number => {
  return ((data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]) >>> 0
}

const parsePngInfo = (data: Uint8Array): ImageInfo | null => {
  if (data.length < 24) return null
  for (let i = 0; i < pngSignature.length; i++) {
    if (data[i] !== pngSignature[i]) return null
  }
  // 第一个块必须是 IHDR，长度 13，含宽(4)/高(4)
  if (readUint32(data, 8) !== 13) return null
  if (data[12] !== 0x49 || data[13] !== 0x48 || data[14] !== 0x44 || data[15] !== 0x52) return null
  const width = readUint32(data, 16)
  const height = readUint32(data, 20)
  if (!width || !height) return null
  return { format: 'png', width, height }
}

/**
 * 解析图片 magic + 尺寸（不校验尺寸范围，便于单测尺寸边界）
 */
export const parseImageInfo = (data: Uint8Array): ImageInfo | null => {
  if (!data || data.length < 3) return null
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return parseJpegInfo(data)
  if (data[0] === 0x89 && data[1] === 0x50) return parsePngInfo(data)
  return null
}

export const isImageSizeAllowed = (width: number, height: number): boolean => {
  return width >= MIN_IMAGE_DIMENSION && width <= MAX_IMAGE_DIMENSION &&
    height >= MIN_IMAGE_DIMENSION && height <= MAX_IMAGE_DIMENSION
}

/**
 * 校验下载数据：体积上限、magic、尺寸范围；失败抛 CoverImageError
 */
export const validateImageData = (data: Uint8Array): ImageInfo => {
  if (!data?.length) throw new CoverImageError('image_invalid', 'empty image data')
  if (data.length > MAX_IMAGE_BYTES) throw new CoverImageError('image_too_large', 'image data too large')
  const info = parseImageInfo(data)
  if (!info) throw new CoverImageError('image_invalid', 'unsupported image format')
  if (!isImageSizeAllowed(info.width, info.height)) {
    throw new CoverImageError('image_invalid', `unsupported image size: ${info.width}x${info.height}`)
  }
  return info
}
