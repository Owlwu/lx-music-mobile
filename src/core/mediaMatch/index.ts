import BackgroundTimer from 'react-native-background-timer'
import { updateListMusics } from '@/core/list'
import { getLyricInfo } from '@/core/music/local'
import { setMusicInfo } from '@/core/player/playInfo'
import playerActions from '@/store/player/action'
import playerState from '@/store/player/state'
import { readEmbeddedLyric } from '@/utils/localMediaMetadata'
import { buildLrcText } from '@/utils/mediaMatch/lrcText'
import { createMatchQuery, getFileStem, parseIntervalToSec } from '@/utils/mediaMatch/query'
import { rankCandidates } from '@/utils/mediaMatch/score'
import { rollbackLrcFile, writeLrcFile, type LrcRollbackResult, type LrcWriteResult } from '@/utils/lrcFile'
import { log } from '@/utils/log'

import * as lrclib from './providers/lrclib'
import * as qq from './providers/qq'

// 整体超时 15s
const OVERALL_TIMEOUT = 15000

interface LyricsProvider {
  id: LX.Music.LyricsSource
  search: (query: LX.Music.MatchQuery, signal?: AbortSignal) => Promise<LX.Music.LyricsCandidate[]>
  getLyric: (candidate: LX.Music.LyricsCandidate, signal?: AbortSignal) => Promise<{ lyric: string, isSynced: boolean } | null>
}

// 源启用顺序固定 lrclib -> qq；QQ 为实验性源，失败自动跳过
const providers: LyricsProvider[] = [lrclib, qq]

export interface SearchLyricsOptions {
  musicInfo: LX.Music.MusicInfoLocal
  keyword?: string
  signal?: AbortSignal
}

const createAbortContext = (signal?: AbortSignal) => {
  const controller = new AbortController()
  let canceled = false
  const timer = BackgroundTimer.setTimeout(() => {
    canceled = true
    controller.abort()
  }, OVERALL_TIMEOUT)
  const handleAbort = () => {
    canceled = true
    controller.abort()
  }
  if (signal?.aborted) handleAbort()
  else signal?.addEventListener?.('abort', handleAbort)

  return {
    signal: controller.signal,
    isCanceled: () => canceled,
    dispose() {
      BackgroundTimer.clearTimeout(timer)
      signal?.removeEventListener?.('abort', handleAbort)
    },
  }
}

/**
 * 根据本地歌曲信息构造匹配查询（UI 的搜索框默认值可用 `name singer`）
 */
export const getMusicMatchQuery = (musicInfo: LX.Music.MusicInfoLocal, keyword?: string): LX.Music.MatchQuery => {
  return createMatchQuery({
    name: musicInfo.name,
    singer: musicInfo.singer,
    albumName: musicInfo.meta.albumName,
    durationSec: parseIntervalToSec(musicInfo.interval),
    fileStem: getFileStem(musicInfo.meta.filePath),
  }, keyword)
}

/**
 * 搜索在线歌词候选：按源顺序请求 -> 聚合 -> 去重 -> 打分 -> 排序 -> 截断 30 条
 */
export const searchLyrics = async({ musicInfo, keyword, signal }: SearchLyricsOptions): Promise<LX.Music.LyricsCandidate[]> => {
  const query = getMusicMatchQuery(musicInfo, keyword)
  if (!query.variants.length) return []

  const abortContext = createAbortContext(signal)
  const candidates: LX.Music.LyricsCandidate[] = []
  let failedSources = 0
  try {
    for (const provider of providers) {
      if (abortContext.isCanceled()) break
      try {
        const result = await provider.search(query, abortContext.signal)
        candidates.push(...result)
      } catch (error: any) {
        if (abortContext.isCanceled()) break
        failedSources++
        log.warn(`media match source ${provider.id} failed: ${error?.message ?? error}`)
      }
    }
  } finally {
    abortContext.dispose()
  }
  if (abortContext.isCanceled() && !candidates.length) return []
  if (!candidates.length && failedSources === providers.length) throw new Error('all lyrics sources failed')
  return rankCandidates(query, candidates)
}

/**
 * 取候选歌词正文；无效歌词（纯音乐/占位文本/过短）返回 null
 */
export const getCandidateLyric = async(candidate: LX.Music.LyricsCandidate, signal?: AbortSignal): Promise<{ lyric: string, isSynced: boolean } | null> => {
  const provider = providers.find(item => item.id === candidate.source)
  if (!provider) throw new Error(`unknown lyrics source: ${candidate.source}`)
  return provider.getLyric(candidate, signal)
}

/**
 * 应用候选：生成 LRC 文本并按文件规则写入（备份/临时文件/失败恢复）
 * @param lyric 已取到的歌词（预览时缓存）；不传则重新取词
 */
export const applyLrcToMusic = async({ musicInfo, candidate, lyric: fetchedLyric }: {
  musicInfo: LX.Music.MusicInfoLocal
  candidate: LX.Music.LyricsCandidate
  lyric?: { lyric: string, isSynced: boolean } | null
}): Promise<LrcWriteResult> => {
  const result = fetchedLyric ?? await getCandidateLyric(candidate)
  if (!result?.lyric.trim()) throw new Error('no valid lyric')
  const text = buildLrcText({
    name: musicInfo.name || candidate.name,
    singer: musicInfo.singer || candidate.singer,
    albumName: musicInfo.meta.albumName || candidate.albumName,
    lyric: result.lyric,
    isSynced: result.isSynced,
  })
  return writeLrcFile(musicInfo.meta.filePath, text)
}

export interface UpdateLyricSourceOptions {
  listId?: string | null
  musicInfo: LX.Music.MusicInfoLocal
  source: LX.Music.LyricSource
}

/**
 * 更新单曲歌词来源偏好（meta.lyricSource），若正在播放该曲则立即刷新歌词
 */
export const updateMusicLyricSource = async({ listId, musicInfo, source }: UpdateLyricSourceOptions): Promise<LX.Music.MusicInfoLocal> => {
  const newMusicInfo: LX.Music.MusicInfoLocal = {
    ...musicInfo,
    meta: {
      ...musicInfo.meta,
      lyricSource: source,
    },
  }
  if (listId) await updateListMusics([{ id: listId, musicInfo: newMusicInfo }])

  const playing = playerState.playMusicInfo
  if (playing.musicInfo?.id === newMusicInfo.id) {
    // 播放中的歌曲信息需要同步成列表里的新对象，后续来源切换才能读到新的 meta
    playerActions.setPlayMusicInfo(playing.listId, newMusicInfo, playing.isTempPlay)
    await refreshPlayingLyric(newMusicInfo)
  }
  return newMusicInfo
}

/**
 * 若当前播放的正是这首歌，重新读取歌词并刷新显示（不重启播放）
 */
export const refreshPlayingLyric = async(musicInfo: LX.Music.MusicInfoLocal): Promise<boolean> => {
  const playing = playerState.playMusicInfo
  if (playing.musicInfo?.id !== musicInfo.id) return false
  try {
    const lyricInfo = await getLyricInfo({ musicInfo, isRefresh: false })
    if (playerState.playMusicInfo.musicInfo?.id !== musicInfo.id) return false
    setMusicInfo({
      lrc: lyricInfo.lyric,
      tlrc: lyricInfo.tlyric,
      rlrc: lyricInfo.rlyric,
      lxlrc: lyricInfo.lxlyric,
      rawlrc: lyricInfo.rawlrcInfo.lyric,
    })
    global.app_event.lyricUpdated()
    return true
  } catch (error: any) {
    log.warn(`refresh playing lyric failed: ${error?.message ?? error}`)
    return false
  }
}

/**
 * 回退外挂 LRC：删除当前 .lrc、恢复 .lrc.bak，并把来源切回内嵌（内嵌不存在时保持 LRC）
 */
export const rollbackLrc = async({ listId, musicInfo }: {
  listId?: string | null
  musicInfo: LX.Music.MusicInfoLocal
}): Promise<LrcRollbackResult> => {
  const result = await rollbackLrcFile(musicInfo.meta.filePath)
  if (!result.restored) return result
  const embeddedLyric = await readEmbeddedLyric(musicInfo.meta.filePath).catch(() => '')
  const source: LX.Music.LyricSource = embeddedLyric.trim() ? 'embedded' : 'lrc'
  await updateMusicLyricSource({ listId, musicInfo, source })
  return result
}
