import BackgroundTimer from 'react-native-background-timer'

import { getListMusics } from '@/core/list'
import { applyLrcToMusic, getCandidateLyric, searchLyrics, updateMusicLyricSource } from '@/core/mediaMatch'
import { applyCoverCandidate, refreshPlayingCover, searchCoverCandidates } from '@/core/coverMatch'
import { getLocalMusicFileState, getMissingKinds } from '@/utils/batchMatch/state'
import { checkCoverMatchablePath } from '@/utils/coverFile'
import { checkLrcMatchablePath } from '@/utils/lrcFile'
import { log } from '@/utils/log'
import { normalizeText } from '@/utils/mediaMatch/normalize'

import { getCoverAttemptIndexes, getLyricAttemptIndexes } from './select'

/** 扫描当前列表，确认待处理项后串行补全高置信候选。 */
export type BatchMatchPhase = 'scanning' | 'matching'

export interface BatchMatchCounts {
  /** 成功补全歌词的歌曲数 */
  lyric: number
  /** 成功补全封面的歌曲数 */
  cover: number
  /** 处理失败的歌曲数（单曲内任一项失败即算一次） */
  failed: number
  /** 跳过处理的歌曲数（本地文件不存在 / 路径不可写） */
  skipped: number
  /** 至少一项需要手动选择的歌曲数 */
  manual: number
}

export interface BatchMatchProgress extends BatchMatchCounts {
  phase: BatchMatchPhase
  current: number
  total: number
  name: string
}

export interface BatchMatchResult extends BatchMatchCounts {
  canceled: boolean
  /** 当前列表里的本地歌曲总数（扫描阶段分母） */
  localTotal: number
  /** 需要补全的歌曲数（补全阶段分母） */
  total: number
  /** 已完整处理的歌曲数（取消时小于 total） */
  processed: number
}

export interface BatchMatchReview {
  total: number
  lyrics: number
  covers: number
  skipped: number
}

export interface BatchMatchOptions {
  listId: string
  confirmTargets: (review: BatchMatchReview) => Promise<boolean>
  signal?: AbortSignal
  onProgress?: (progress: BatchMatchProgress) => void
  /** 每首之间的间隔，默认 200ms（契约 §3） */
  intervalMs?: number
}

interface BatchMatchTarget {
  musicInfo: LX.Music.MusicInfoLocal
  needLyric: boolean
  needCover: boolean
}

type ItemResult = 'ok' | 'fail' | 'canceled' | 'manual' | 'skipped'

const sleep = async(ms: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    BackgroundTimer.setTimeout(resolve, ms)
  })
}

const getMusicName = (musicInfo: LX.Music.MusicInfoLocal): string => {
  return musicInfo.name || musicInfo.meta.filePath.substring(musicInfo.meta.filePath.lastIndexOf('/') + 1)
}

const createEmptyResult = (): BatchMatchResult => ({
  canceled: false,
  localTotal: 0,
  total: 0,
  processed: 0,
  lyric: 0,
  cover: 0,
  failed: 0,
  skipped: 0,
  manual: 0,
})

export const runBatchMatch = async({
  listId,
  confirmTargets,
  signal,
  onProgress,
  intervalMs = 200,
}: BatchMatchOptions): Promise<BatchMatchResult> => {
  const result = createEmptyResult()
  const isCanceled = () => !!signal?.aborted
  const emit = (progress: BatchMatchProgress) => {
    try {
      onProgress?.(progress)
    } catch (error: any) {
      log.warn(`batch match progress callback failed: ${error?.message ?? error}`)
    }
  }
  const emitCounts = (phase: BatchMatchPhase, current: number, total: number, name: string) => {
    emit({
      phase,
      current,
      total,
      name,
      lyric: result.lyric,
      cover: result.cover,
      failed: result.failed,
      skipped: result.skipped,
      manual: result.manual,
    })
  }

  // 扫描只读取本地状态。
  const musics = await getListMusics(listId)
  const localMusics = musics.filter(musicInfo => musicInfo.source === 'local')
  result.localTotal = localMusics.length
  if (!localMusics.length) return result

  const targets: BatchMatchTarget[] = []
  for (let index = 0; index < localMusics.length; index++) {
    if (isCanceled()) {
      result.canceled = true
      return result
    }
    const musicInfo = localMusics[index]
    emitCounts('scanning', index + 1, localMusics.length, getMusicName(musicInfo))

    let state
    try {
      state = await getLocalMusicFileState(musicInfo.meta.filePath)
    } catch (error: any) {
      log.warn(`get local music file state failed: ${musicInfo.meta.filePath}\n${error?.message ?? error}`)
      result.skipped++
      continue
    }
    if (!state.fileExists) {
      // 本地文件不存在（坏路径）按跳过处理，不污染失败数（契约 §6）
      result.skipped++
      continue
    }

    const missing = getMissingKinds(state)
    if (!missing.lyric && !missing.cover) continue

    const filePath = musicInfo.meta.filePath
    // content:// 与 App 私有目录无法写回同名文件：该项不处理；两项都不可写则整首跳过
    const needLyric = missing.lyric && checkLrcMatchablePath(filePath) === 'ok'
    const needCover = missing.cover && checkCoverMatchablePath(filePath) === 'ok'
    if (!needLyric && !needCover) {
      result.skipped++
      continue
    }
    targets.push({ musicInfo, needLyric, needCover })
  }

  result.total = targets.length
  if (isCanceled()) {
    result.canceled = true
    return result
  }
  if (!targets.length) return result

  const confirmed = await confirmTargets({
    total: targets.length,
    lyrics: targets.filter(target => target.needLyric).length,
    covers: targets.filter(target => target.needCover).length,
    skipped: result.skipped,
  })
  if (!confirmed || isCanceled()) {
    result.canceled = true
    return result
  }

  // 2. 补全：串行逐首，先歌词后封面
  for (let index = 0; index < targets.length; index++) {
    if (isCanceled()) {
      result.canceled = true
      break
    }
    const target = targets[index]
    const name = getMusicName(target.musicInfo)
    emitCounts('matching', index + 1, targets.length, name)

    const outcomes: ItemResult[] = []
    try {
      const missing = getMissingKinds(await getLocalMusicFileState(target.musicInfo.meta.filePath))
      if (target.needLyric && !isCanceled()) {
        const outcome = missing.lyric ? await tryMatchLyric(target.musicInfo, listId, signal) : 'skipped'
        outcomes.push(outcome)
        if (outcome === 'ok') result.lyric++
      }
      if (target.needCover && !isCanceled()) {
        const outcome = missing.cover ? await tryMatchCover(target.musicInfo, signal) : 'skipped'
        outcomes.push(outcome)
        if (outcome === 'ok') result.cover++
      }
    } catch (error: any) {
      outcomes.push('fail')
      log.warn(`batch match process song failed: ${name}\n${error?.message ?? error}`)
    }

    if (outcomes.includes('fail')) result.failed++
    if (outcomes.includes('manual')) result.manual++
    if (outcomes.includes('skipped')) result.skipped++
    result.processed++
    emitCounts('matching', index + 1, targets.length, name)

    if (isCanceled()) {
      result.canceled = true
      break
    }
    if (index < targets.length - 1) {
      await sleep(intervalMs)
      if (isCanceled()) {
        result.canceled = true
        break
      }
    }
  }

  log.info(`batch match finished: lyric ${result.lyric}, cover ${result.cover}, failed ${result.failed}, manual ${result.manual}, skipped ${result.skipped}, processed ${result.processed}/${result.total}${result.canceled ? ', canceled' : ''}`)
  return result
}

/**
 * 歌词：搜索 -> 按自动选择顺序取词 -> 写 .lrc -> 来源偏好切到 lrc
 *
 * 取词失败（null / 抛错）继续试下一个候选；写盘失败直接算本项失败，
 * 不再拿另一份歌词反复覆盖同一首。
 */
const tryMatchLyric = async(musicInfo: LX.Music.MusicInfoLocal, listId: string, signal?: AbortSignal): Promise<ItemResult> => {
  let candidates: LX.Music.LyricsCandidate[]
  try {
    candidates = await searchLyrics({ musicInfo, signal })
  } catch (error: any) {
    if (signal?.aborted) return 'canceled'
    log.warn(`batch match search lyric failed: ${musicInfo.name}\n${error?.message ?? error}`)
    return 'fail'
  }
  const indexes = getLyricAttemptIndexes(candidates)
  let needsManual = candidates.length > 0 && !indexes.length
  for (const index of indexes) {
    if (signal?.aborted) return 'canceled'
    const candidate = candidates[index]
    let lyric: LX.Music.LyricResult | null
    try {
      lyric = await getCandidateLyric(candidate, signal)
    } catch (error: any) {
      if (signal?.aborted) return 'canceled'
      log.warn(`batch match get lyric failed: ${candidate.source}/${candidate.id}\n${error?.message ?? error}`)
      continue
    }
    if (!lyric?.lyric.trim()) continue
    if (!lyric.isSynced) {
      needsManual = true
      continue
    }

    if (signal?.aborted) return 'canceled'
    try {
      await applyLrcToMusic({ musicInfo, candidate, lyric, onlyIfMissing: true })
    } catch (error: any) {
      if (error?.code === 'already_exists') return 'skipped'
      log.warn(`batch match apply lyric failed: ${musicInfo.meta.filePath}\n${error?.message ?? error}`)
      return 'fail'
    }
    try {
      await updateMusicLyricSource({ listId, musicInfo, source: 'lrc' })
    } catch (error: any) {
      // .lrc 已写入成功，来源偏好更新失败不影响补全结果
      log.warn(`batch match update lyric source failed: ${musicInfo.name}\n${error?.message ?? error}`)
    }
    return 'ok'
  }
  if (needsManual) return 'manual'
  log.warn(`batch match no usable lyric: ${musicInfo.name}`)
  return 'fail'
}

/**
 * 封面：搜索 -> 前 3 个候选依次下载写入 -> 刷新当前播放封面
 */
const tryMatchCover = async(musicInfo: LX.Music.MusicInfoLocal, signal?: AbortSignal): Promise<ItemResult> => {
  let candidates: LX.Music.CoverCandidate[]
  try {
    candidates = await searchCoverCandidates({ musicInfo, signal })
  } catch (error: any) {
    if (signal?.aborted) return 'canceled'
    log.warn(`batch match search cover failed: ${musicInfo.name}\n${error?.message ?? error}`)
    return 'fail'
  }
  const album = normalizeText(musicInfo.meta.albumName ?? '')
  const albumMatches = album ? candidates.filter(candidate => normalizeText(candidate.albumName) === album) : []
  const indexes = getCoverAttemptIndexes(albumMatches)
  if (candidates.length && !indexes.length) return 'manual'
  for (const index of indexes) {
    if (signal?.aborted) return 'canceled'
    const candidate = albumMatches[index]
    try {
      await applyCoverCandidate({ musicInfo, candidate, onlyIfMissing: true, signal })
    } catch (error: any) {
      if (signal?.aborted) return 'canceled'
      if (error?.code === 'already_exists') return 'skipped'
      log.warn(`batch match apply cover failed: ${musicInfo.name}\n${error?.message ?? error}`)
      continue
    }
    await refreshPlayingCover(musicInfo)
    return 'ok'
  }
  log.warn(`batch match no usable cover: ${musicInfo.name}`)
  return 'fail'
}
