// LRC 文本生成（纯函数，无平台依赖）

export interface LrcTextCandidate {
  name: string
  singer: string
  albumName: string
  lyric: string
  isSynced: boolean
}

const trimTagValue = (value: string): string => value.replace(/[\r\n]/g, ' ').replace(/]/g, '〕').trim()

// 源歌词自带的头部标签行（写入前剔除，避免与本地生成的头部重复；[offset:] 等其它标签保留）
const sourceHeaderTagRxp = /^\s*\[(?:ti|ar|al|by):.*]\s*$/i
// 逐字歌词的词级时间标签（如 <0,300>），.lrc 只保留行级时间轴，写入前剔除
const wordTimingRxp = /<[\d:.,]+>/g
// 预览用的纯标签行（如 [offset:0]、[re:]），时间标签行以数字开头不会命中
const metadataTagLineRxp = /^\s*\[[a-z][a-z0-9_-]*:.*]\s*$/i

/**
 * 生成写入 .lrc 文件的文本：
 * - 头部有值才写 [ti:]/[ar:]/[al:]
 * - 正文保留源返回的行（剔除源自带的 [ti:]/[ar:]/[al:]/[by:] 头部行），
 *   每行 trimEnd，连续空行合并，结尾补一个换行
 * - 统一 \n 换行、UTF-8 无 BOM（BOM 在 lrcFile 写入时二次兜底清理）
 */
export const buildLrcText = (candidate: LrcTextCandidate): string => {
  const lines: string[] = []
  const name = trimTagValue(candidate.name ?? '')
  const singer = trimTagValue(candidate.singer ?? '')
  const albumName = trimTagValue(candidate.albumName ?? '')
  if (name) lines.push(`[ti:${name}]`)
  if (singer) lines.push(`[ar:${singer}]`)
  if (albumName) lines.push(`[al:${albumName}]`)

  const body: string[] = []
  const sourceLines = (candidate.lyric ?? '').replace(/\r\n?/g, '\n').split('\n')
  for (const sourceLine of sourceLines) {
    // 剔除源歌词自带的 [ti:]/[ar:]/[al:]/[by:] 行，头部统一由本地歌曲信息生成
    if (sourceHeaderTagRxp.test(sourceLine)) continue
    let line = sourceLine.replace(wordTimingRxp, '').trimEnd()
    if (!line) {
      // 连续空行合并为一个
      if (body.length && body[body.length - 1] !== '') body.push('')
      continue
    }
    body.push(line)
  }
  // 去掉正文首尾的空行
  while (body.length && body[0] === '') body.shift()
  while (body.length && body[body.length - 1] === '') body.pop()

  lines.push(...body)
  return lines.length ? `${lines.join('\n')}\n` : ''
}

/**
 * 生成用于预览的歌词行（最多 maxLines 行）
 * - 过滤 [ti:]/[ar:]/[al:]/[by:] 等纯标签行（含 [offset:]）
 * - 剔除 <0,300> 这类词级时间标签，避免预览出现原始标签
 * - 跳过空行
 */
export const getLyricPreviewLines = (lyric: string, maxLines = 30): string[] => {
  if (!lyric) return []
  const lines: string[] = []
  for (const sourceLine of lyric.replace(/\r\n?/g, '\n').split('\n')) {
    if (metadataTagLineRxp.test(sourceLine)) continue
    const line = sourceLine.replace(wordTimingRxp, '').trimEnd()
    if (!line.trim()) continue
    lines.push(line)
    if (lines.length >= maxLines) break
  }
  return lines
}
