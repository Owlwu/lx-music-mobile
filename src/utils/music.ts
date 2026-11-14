import { existsFile, unlink } from './fs'
import { checkWritableLocalPath } from './localPathCheck'
import { getLocalMusicSidecarPaths } from './musicSidecar'


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

/**
 * 删除本地歌曲文件，并一并清理同目录同名附属文件：
 * 歌词 `.lrc/.LRC`（含 `.bak`、临时文件）与封面 `.jpg/.png`（含 `.bak`、临时文件）。
 *
 * 仅在设置 `list.isDeleteLocalFileWhenRemove` 开启时由移除流程调用；
 * 附属文件删除失败静默忽略，音频删除失败仍向上抛错（与原行为一致）。
 */
export const deleteLocalMusicFiles = async(musicInfo: LX.Music.MusicInfoLocal) => {
  const filePath = musicInfo.meta.filePath
  // 只对真实用户目录生效；content://、App 缓存/私有副本不处理
  const sidecarPaths = checkWritableLocalPath(filePath) === 'ok' ? getLocalMusicSidecarPaths(filePath) : []
  await Promise.all([
    unlink(filePath),
    ...sidecarPaths.map(async sidecarPath => {
      try {
        await unlink(sidecarPath)
      } catch {}
    }),
  ])
}
