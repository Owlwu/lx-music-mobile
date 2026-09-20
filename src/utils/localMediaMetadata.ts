import { temporaryDirectoryPath, readDir, unlink, extname, readFile, type FileType } from '@/utils/fs'
import { readPic as _readPic, readLyric as _readLyric } from 'react-native-local-media-metadata'
import iconv from 'iconv-lite'
import { log } from '@/utils/log'
export {
  type MusicMetadata,
  type MusicMetadataFull,
  readMetadata,
  writeMetadata,
  writePic,
  writeLyric,
} from 'react-native-local-media-metadata'

const replacementChar = '\uFFFD'
// UniversalDetector 会将部分包含日文假名的 GBK 编码歌词文件误判为日文编码（如 EUC-JP），
// 解码后会残留替换字符（乱码），此时尝试使用其它常见编码重新解码原始字节
const fallbackEncodings = ['gb18030', 'big5', 'shift_jis', 'euc-jp', 'euc-kr']

const countReplacementChar = (str: string) => {
  let count = 0
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) === 0xFFFD) count++
  }
  return count
}

const decodeLyricBuffer = (data: Buffer): string | null => {
  let best: string | null = null
  let bestCount = Infinity
  for (const encoding of fallbackEncodings) {
    const text = iconv.decode(data, encoding)
    const count = countReplacementChar(text)
    if (count < bestCount) {
      best = text
      bestCount = count
    }
    if (count === 0) break
  }
  return best
}

export const getLrcFilePath = (filePath: string) => {
  const index = filePath.lastIndexOf('.')
  return index === -1 ? `${filePath}.lrc` : `${filePath.substring(0, index)}.lrc`
}

/**
 * 读取歌词
 *
 * 优先读取歌曲内嵌歌词，内嵌歌词不存在时再读取同名的外挂歌词文件（.lrc）
 * 对于外挂歌词文件，在原生模块因编码识别错误导致乱码时，重新读取原始字节并使用
 * 常见编码进行解码，以修复部分歌词乱码的问题
 * @param filePath 歌曲文件路径
 * @param isReadLrcFile 内嵌歌词不存在时是否读取同名的 .lrc 文件
 */
export const readLyric = async(filePath: string, isReadLrcFile = true): Promise<string> => {
  // 优先读取歌曲内嵌歌词
  const embeddedLyric = await _readLyric(filePath, false).catch(() => '')
  if (embeddedLyric || !isReadLrcFile) return embeddedLyric
  const lyric = await _readLyric(filePath, true)
  if (!lyric || !lyric.includes(replacementChar)) return lyric
  try {
    const base64 = await readFile(getLrcFilePath(filePath), 'base64')
    const decoded = decodeLyricBuffer(Buffer.from(base64, 'base64'))
    if (decoded != null && !decoded.includes(replacementChar)) return decoded
  } catch (error: any) {
    log.warn(`Failed to decode lyric file: ${filePath}\n${error?.message ?? error}`)
  }
  return lyric
}

let cleared = false
const picCachePath = temporaryDirectoryPath + '/local-media-metadata'

const isAudioFile = (file: FileType) => {
  if (file.mimeType?.startsWith('audio/')) return true
  if (extname(file?.name ?? '') === 'ogg') return true
  return false
}

export const scanAudioFiles = async(dirPath: string): Promise<FileType[]> => {
  const audioFiles: FileType[] = []
  let files: FileType[]
  try {
    files = await readDir(dirPath)
  } catch (error: any) {
    log.warn(`Failed to scan folder: ${dirPath}\n${error.stack ?? error.message}`)
    return audioFiles
  }
  for (const file of files) {
    if (file.isDirectory) {
      audioFiles.push(...await scanAudioFiles(file.path))
    } else if (isAudioFile(file)) {
      audioFiles.push(file)
    }
  }
  return audioFiles
}

const clearPicCache = async() => {
  await unlink(picCachePath)
  cleared = true
}

export const readPic = async(dirPath: string): Promise<string> => {
  if (!cleared) await clearPicCache()
  return _readPic(dirPath, picCachePath)
}

// export interface MusicMetadata {
//   type: 'mp3' | 'flac' | 'ogg' | 'wav'
//   bitrate: string
//   interval: number
//   size: number
//   ext: 'mp3' | 'flac' | 'ogg' | 'wav'
//   albumName: string
//   singer: string
//   name: string
// }
// export const readMetadata = async(filePath: string): Promise<MusicMetadata | null> => {
//   return LocalMediaModule.readMetadata(filePath)
// }

// export const readPic = async(filePath: string): Promise<string> => {
//   return LocalMediaModule.readPic(filePath)
// }

// export const readLyric = async(filePath: string): Promise<string> => {
//   return LocalMediaModule.readLyric(filePath)
// }


