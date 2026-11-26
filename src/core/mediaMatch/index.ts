import BackgroundTimer from 'react-native-background-timer'
import { updateListMusics } from '@/core/list'
import { getLyricInfo } from '@/core/music/local'
import { setMusicInfo } from '@/core/player/playInfo'
import playerActions from '@/store/player/action'
import playerState from '@/store/player/state'
import { clearMusicLyric } from '@/utils/data'
import { buildLrcText } from '@/utils/mediaMatch/lrcText'
import { createMatchQuery, getFileStem, parseIntervalToSec } from '@/utils/mediaMatch/query'
import { rankCandidates } from '@/utils/mediaMatch/score'
import { deleteLrcFile, writeLrcFile, type LrcWriteResult } from '@/utils/lrcFile'
import { log } from '@/utils/log'

import * as lrclib from './providers/lrclib'
import * as netease from './providers/netease'
import * as qq from './providers/qq'

// 三源并行后整体只留兜底超时（原串行版本为 20s）；仍可被弹窗关闭 abort
const OVERALL_TIMEOUT = 12000
// 单源预算：慢源到点即中止，不拖累其他源已经拿到的候选
const SOURCE_TIMEOUT = 8000

interface LyricsProvider {
  id: LX.Music.LyricsSource
  search: (query: LX.Music.MatchQuery, signal?: AbortSignal) => Promise<LX.Music.LyricsCandidate[]>
  getLyric: (candidate: LX.Music.LyricsCandidate, signal?: AbortSignal) => Promise<LX.Music.LyricResult | null>
}

// 源启用顺序固定 lrclib -> qq -> netease；netease 带翻译/罗马音，失败自动跳过
const providers: LyricsProvider[] = [lrclib, qq, netease]

interface SourceOutcome {
  candidates: LX.Music.LyricsCandidate[]
  failed: boolean
}

export interface SearchLyricsOptions {
  musicInfo: LX.Music.MusicInfoLocal
  keyword?: string
  signal?: AbortSignal
}

const createAbortContext = (signal?: AbortSignal) => {
  const controller = new AbortController()
  let canceled = false
  let timedOut = false
  const timer = BackgroundTimer.setTimeout(() => {
    canceled = true
    timedOut = true
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
    // 仅整体兜底超时才会为 true，用于区分「用户关闭」与「真的超时」
    isTimedOut: () => timedOut,
    dispose() {
      BackgroundTimer.clearTimeout(timer)
      signal?.removeEventListener?.('abort', handleAbort)
    },
  }
}

/**
 * 单源超时上下文：父信号（整体超时 / 弹窗关闭）或自身计时器任一触发即中止该源请求
 */
const createSourceContext = (parentSignal: AbortSignal, timeout: number) => {
  const controller = new AbortController()
  let timedOut = false
  const timer = BackgroundTimer.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeout)
  const handleAbort = () => { controller.abort() }
  if (parentSignal.aborted) handleAbort()
  else parentSignal.addEventListener?.('abort', handleAbort)

  return {
    signal: controller.signal,
    isTimedOut: () => timedOut,
    dispose() {
      BackgroundTimer.clearTimeout(timer)
      parentSignal.removeEventListener?.('abort', handleAbort)
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
 * 搜索在线歌词候选：并行请求各源 -> 聚合 -> 去重 -> 打分 -> 排序 -> 截断 30 条
 */
export const searchLyrics = async({ musicInfo, keyword, signal }: SearchLyricsOptions): Promise<LX.Music.LyricsCandidate[]> => {
  const query = getMusicMatchQuery(musicInfo, keyword)
  if (!query.variants.length) return []

  const startAt = Date.now()
  const abortContext = createAbortContext(signal)
  let outcomes: SourceOutcome[] = []
  try {
    // 三源并行（与桌面端 matcher.ts 对齐）：串行会让各源延迟相加，
    // 一个慢源就能吃光整体预算，使后面的源根本没机会返回
    outcomes = await Promise.all(providers.map(async(provider): Promise<SourceOutcome> => {
      const sourceContext = createSourceContext(abortContext.signal, SOURCE_TIMEOUT)
      try {
        const candidates = await provider.search(query, sourceContext.signal)
        // 源在超时点被中止时可能返回半成品：空结果按失败处理，避免「超时」被当成「没匹配到」
        if (sourceContext.isTimedOut() && !candidates.length) throw new Error(`source timeout ${SOURCE_TIMEOUT}ms`)
        return { candidates, failed: false }
      } catch (error: any) {
        if (!abortContext.isCanceled()) log.warn(`media match source ${provider.id} failed: ${error?.message ?? error}`)
        return { candidates: [], failed: true }
      } finally {
        sourceContext.dispose()
      }
    }))
  } finally {
    abortContext.dispose()
  }

  const candidates: LX.Music.LyricsCandidate[] = []
  for (const outcome of outcomes) candidates.push(...outcome.candidates)
  log.info(`media match search: ${candidates.length} candidates from ${providers.length} sources in ${Date.now() - startAt}ms`)
  // 只要拿到候选就交付：个别源失败/超时不影响已经可用的结果
  if (candidates.length) return rankCandidates(query, candidates)

  // 用户关闭弹窗或被新一轮搜索取代（外部 abort）：静默返回空，UI 侧会丢弃本轮结果
  if (abortContext.isCanceled() && !abortContext.isTimedOut()) return []

  const failedCount = outcomes.filter(outcome => outcome.failed).length
  // 全部或部分源失败且 0 条时必须抛错：否则「网络失败」会被 UI 显示成「没匹配到」，
  // 表现为列表为空、多搜几次才出结果
  if (abortContext.isTimedOut() || failedCount === providers.length) throw new Error('all lyrics sources failed')
  if (failedCount > 0) throw new Error(`lyrics sources incomplete (${failedCount}/${providers.length} failed)`)
  return []
}

/**
 * 取候选歌词正文（netease 源可带翻译/罗马音）；无效歌词（纯音乐/占位文本/过短）返回 null
 */
export const getCandidateLyric = async(candidate: LX.Music.LyricsCandidate, signal?: AbortSignal): Promise<LX.Music.LyricResult | null> => {
  const provider = providers.find(item => item.id === candidate.source)
  if (!provider) throw new Error(`unknown lyrics source: ${candidate.source}`)
  return provider.getLyric(candidate, signal)
}

/**
 * 应用候选：生成 LRC 文本并按文件规则写入（临时文件写入后替换）
 * @param lyric 已取到的歌词（预览时缓存）；不传则重新取词
 */
export const applyLrcToMusic = async({ musicInfo, candidate, lyric: fetchedLyric }: {
  musicInfo: LX.Music.MusicInfoLocal
  candidate: LX.Music.LyricsCandidate
  lyric?: LX.Music.LyricResult | null
}): Promise<LrcWriteResult> => {
  const result = fetchedLyric ?? await getCandidateLyric(candidate)
  if (!result?.lyric.trim()) throw new Error('no valid lyric')
  const text = buildLrcText({
    name: musicInfo.name || candidate.name,
    singer: musicInfo.singer || candidate.singer,
    albumName: musicInfo.meta.albumName || candidate.albumName,
    lyric: result.lyric,
    isSynced: result.isSynced,
    tlyric: result.tlyric,
    rlyric: result.rlyric,
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

export const deleteLrc = async(musicInfo: LX.Music.MusicInfoLocal): Promise<boolean> => {
  const deleted = await deleteLrcFile(musicInfo.meta.filePath)
  if (deleted) await clearMusicLyric(musicInfo)
  await refreshPlayingLyric(musicInfo)
  return deleted
}
