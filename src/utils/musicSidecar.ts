// 本地歌曲同名附属文件（封面 / 歌词）路径生成（纯函数，无平台依赖）
//
// 用于「从列表移除本地歌曲并同时删除本地文件」时一并清理同名附属文件：
// - 歌词：`.lrc` / `.LRC` 及 `.bak`、临时文件
// - 封面：小写 `.jpg` / `.png`，以及旧版 `.bak`、暂存/回滚临时文件
// 只生成路径，不判断文件是否存在；是否可写/是否真实路径由调用方先校验。

const uriSchemeRxp = /^[a-z][a-z0-9+.-]*:/i

const getStem = (filePath: string): string => {
  const dirIndex = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const dotIndex = filePath.lastIndexOf('.')
  return dotIndex > dirIndex ? filePath.substring(0, dotIndex) : filePath
}

/**
 * 歌曲对应的同名附属文件路径（歌词优先，其次封面）。
 * 非绝对路径 / URI 返回空数组。
 */
export const getLocalMusicSidecarPaths = (filePath: string): string[] => {
  if (!filePath || typeof filePath !== 'string' || !filePath.startsWith('/')) return []
  if (uriSchemeRxp.test(filePath)) return []
  const stem = getStem(filePath)
  if (!stem) return []

  const paths = [
    // 外挂歌词（读取链路兼容大写 .LRC）与备份/临时文件
    `${stem}.lrc`,
    `${stem}.LRC`,
    `${stem}.lrc.bak`,
    `${stem}.LRC.bak`,
    `${stem}.lrc.tmp`,
    `${stem}.LRC.tmp`,
    `${stem}.lrc.restore.tmp`,
    `${stem}.LRC.restore.tmp`,
    // 同名封面（jpg 优先、png 其次）与备份/临时文件
    `${stem}.jpg`,
    `${stem}.png`,
    `${stem}.jpg.bak`,
    `${stem}.png.bak`,
    `${stem}.jpg.tmp`,
    `${stem}.png.tmp`,
    `${stem}.jpg.rollback.tmp`,
    `${stem}.png.rollback.tmp`,
    `${stem}.jpg.bak.replaced.tmp`,
    `${stem}.png.bak.replaced.tmp`,
  ]
  return [...new Set(paths)]
}
