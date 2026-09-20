import { existsFile, unlink } from './fs'
import { getLrcFilePath } from './localMediaMetadata'


export const getLocalFilePath = async(musicInfo: LX.Music.MusicInfoLocal): Promise<string> => {
  if (await existsFile(musicInfo.meta.filePath)) return musicInfo.meta.filePath
  // 直接从应用外 intent 调用打开的文件，ogg等类型无法判断文件是否存在，但这类文件路径为纯数字
  return /\/\d+$/.test(musicInfo.meta.filePath) ? musicInfo.meta.filePath : ''
}

export const deleteLocalMusicFiles = async(musicInfo: LX.Music.MusicInfoLocal) => {
  const filePath = musicInfo.meta.filePath
  await Promise.all([
    unlink(filePath),
    unlink(getLrcFilePath(filePath)).catch(() => {}),
  ])
}
