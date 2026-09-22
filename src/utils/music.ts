import { existsFile, unlink } from './fs'
import { getLrcFilePath } from './localMediaMetadata'


export const getLocalFilePath = async(musicInfo: LX.Music.MusicInfoLocal): Promise<string> => {
  if (await existsFile(musicInfo.meta.filePath)) return musicInfo.meta.filePath
  // 直接从应用外 intent 调用打开的文件，ogg等类型无法判断文件是否存在，但这类文件路径为纯数字
  return /\/\d+$/.test(musicInfo.meta.filePath) ? musicInfo.meta.filePath : ''
}

const uriSchemeRxp = /^[a-z][a-z0-9+.-]*:/i

/**
 * 将本地文件路径转换为可播放的 URL。
 * 直接使用原始路径时，路径中的 `#` 会被 Uri.parse 当作 fragment 分隔符导致文件无法播放，
 * 因此这里对路径进行百分号编码并添加 `file://` 前缀（已是 URI 的 content:// 等不处理）。
 */
export const formatLocalFilePathToUrl = (filePath: string): string => {
  if (uriSchemeRxp.test(filePath)) return filePath
  return `file://${filePath.split('/').map(encodeURIComponent).join('/')}`
}

export const deleteLocalMusicFiles = async(musicInfo: LX.Music.MusicInfoLocal) => {
  const filePath = musicInfo.meta.filePath
  await Promise.all([
    unlink(filePath),
    unlink(getLrcFilePath(filePath)).catch(() => {}),
  ])
}
