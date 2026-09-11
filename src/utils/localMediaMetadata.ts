import { temporaryDirectoryPath, readDir, unlink, extname, type FileType } from '@/utils/fs'
import { readPic as _readPic } from 'react-native-local-media-metadata'
import { log } from '@/utils/log'
export {
  type MusicMetadata,
  type MusicMetadataFull,
  readMetadata,
  writeMetadata,
  writePic,
  readLyric,
  writeLyric,
} from 'react-native-local-media-metadata'

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


