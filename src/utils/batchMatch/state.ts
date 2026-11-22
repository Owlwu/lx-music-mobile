import { existsFile, stat } from '@/utils/fs'
import { getCoverImagePathIfExists } from '@/utils/coverFile'
import { getLrcFilePath } from '@/utils/lrcFile'
import { readEmbeddedLyric, readPic } from '@/utils/localMediaMetadata'
import { log } from '@/utils/log'

/**
 * 一键补全前的单曲文件状态探测。
 *
 * 契约（docs/phase6-batch-match-design.md §4 移动端）：
 * - 同目录歌词：`.lrc` / `.LRC`，`exists` 且 `size > 0`（0 字节视为不存在）；
 * - 同目录封面：`getCoverImagePathIfExists`（jpg 优先、png 回退），同样 0 字节视为不存在；
 * - 内嵌歌词 / 内嵌封面：**仅当对应独立文件缺失时**才调用原生模块解析，
 *   避免「已有外挂歌词/封面还要读一遍音频标签」的无谓开销。
 */

export interface LocalMusicFileState {
  /** 音频文件本身是否存在 */
  fileExists: boolean
  /** 音频内嵌歌词是否可用（有独立歌词文件时不再解析，返回 false） */
  hasEmbeddedLyric: boolean
  /** 同目录同名 `.lrc` / `.LRC` 是否存在且非 0 字节 */
  hasSidecarLyric: boolean
  /** 音频内嵌封面是否可用（有独立封面文件时不再解析，返回 false） */
  hasEmbeddedCover: boolean
  /** 同目录同名 `.jpg` / `.png` 是否存在且非 0 字节 */
  hasSidecarCover: boolean
}

export interface MissingMatchKinds {
  /** 歌词缺失 = 无内嵌 且 无独立文件 */
  lyric: boolean
  /** 封面缺失 = 无内嵌 且 无独立文件 */
  cover: boolean
}

export const emptyLocalMusicFileState = (): LocalMusicFileState => ({
  fileExists: false,
  hasEmbeddedLyric: false,
  hasSidecarLyric: false,
  hasEmbeddedCover: false,
  hasSidecarCover: false,
})

/**
 * 文件存在且体积 > 0 才算「有」（契约 §1.3 / §6：空文件按缺失处理）
 */
const hasNonEmptyFile = async(filePath: string): Promise<boolean> => {
  try {
    if (!(await existsFile(filePath))) return false
    const info = await stat(filePath)
    return info.size > 0
  } catch {
    return false
  }
}

/**
 * 同目录歌词文件：优先 `.lrc`，兼容 `.LRC`（与 `readLrcFile` 的查找顺序一致）
 */
const getSidecarLyricState = async(filePath: string): Promise<boolean> => {
  const lrcPath = getLrcFilePath(filePath)
  if (await hasNonEmptyFile(lrcPath)) return true
  const upperLrcPath = `${lrcPath.substring(0, lrcPath.length - 4)}.LRC`
  return hasNonEmptyFile(upperLrcPath)
}

/**
 * 同目录封面文件：复用 `utils/coverFile` 的 jpg → png 查找，再补一次 0 字节判断
 */
const getSidecarCoverState = async(filePath: string): Promise<boolean> => {
  const cover = await getCoverImagePathIfExists(filePath).catch(() => null)
  if (!cover) return false
  return hasNonEmptyFile(cover.path)
}

/**
 * 探测本地歌曲的歌词/封面状态。
 *
 * 音频文件不存在时直接返回全 false（调用方按 skipped 处理，不读任何标签/同目录文件）。
 * `readPic` 返回缓存路径，空串或抛错都视为无内嵌封面。
 */
export const getLocalMusicFileState = async(filePath: string): Promise<LocalMusicFileState> => {
  const state = emptyLocalMusicFileState()
  if (!filePath) return state

  const fileExists = await existsFile(filePath).catch(() => false)
  if (!fileExists) return state
  state.fileExists = true

  const [hasSidecarLyric, hasSidecarCover] = await Promise.all([
    getSidecarLyricState(filePath),
    getSidecarCoverState(filePath),
  ])
  state.hasSidecarLyric = hasSidecarLyric
  state.hasSidecarCover = hasSidecarCover

  const [hasEmbeddedLyric, hasEmbeddedCover] = await Promise.all([
    hasSidecarLyric
      ? Promise.resolve(false)
      : readEmbeddedLyric(filePath)
        .then(lyric => !!lyric.trim())
        .catch((error: any) => {
          log.warn(`read embedded lyric failed: ${filePath}\n${error?.message ?? error}`)
          return false
        }),
    hasSidecarCover
      ? Promise.resolve(false)
      : readPic(filePath)
        .then(pic => !!pic)
        .catch((error: any) => {
          log.warn(`read embedded cover failed: ${filePath}\n${error?.message ?? error}`)
          return false
        }),
  ])
  state.hasEmbeddedLyric = hasEmbeddedLyric
  state.hasEmbeddedCover = hasEmbeddedCover

  return state
}

/**
 * 由文件状态推导「需要补全」的项：只有内嵌与独立文件都缺失才算缺失
 */
export const getMissingKinds = (state: LocalMusicFileState): MissingMatchKinds => ({
  lyric: state.fileExists && !state.hasEmbeddedLyric && !state.hasSidecarLyric,
  cover: state.fileExists && !state.hasEmbeddedCover && !state.hasSidecarCover,
})
