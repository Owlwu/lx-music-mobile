import BackgroundTimer from 'react-native-background-timer'
import { getPicPath } from '@/core/music'
import { setMusicInfo } from '@/core/player/playInfo'
import playerState from '@/store/player/state'
import { existsFile } from '@/utils/fs'
import { log } from '@/utils/log'
import {
  applyCoverImage,
  checkCoverMatchablePath,
  getCoverState as getCoverFileState,
  rollbackCover as rollbackCoverFile,
  CoverFileError,
} from '@/utils/coverFile'
import { MAX_IMAGE_BYTES, validateImageData } from '@/utils/coverMatch/image'
import { rankCoverCandidates } from '@/utils/coverMatch/score'
import { createMatchQuery, getFileStem, parseIntervalToSec } from '@/utils/mediaMatch/query'
import { httpFetch } from '@/utils/request'

import * as itunes from './providers/itunes'
import * as qq from './providers/qq'

/**
 * 在线封面匹配编排：
 * - 搜索：QQ + iTunes 并行，失败降级，统一评分/专辑去重/截断 20 条
 * - 应用：候选白名单校验 → 下载（10s 超时 / ≤8MB / magic 校验 / 失败重试 1 次）→ 写同名图
 * - 状态/回退：包装 `@/utils/coverFile`，路径不可写时不碰 fs
 * - 刷新：命中当前播放时重取封面并通知界面，不重启播放
 */

// 整体搜索超时 15s
const OVERALL_TIMEOUT = 15000
const MAX_RESULT_COUNT = 20

const DOWNLOAD_TIMEOUT = 10000
const DOWNLOAD_RETRY = 1
const DOWNLOAD_RETRY_DELAY = 300
const JPEG_CONTENT_TYPE_RXP = /^image\/(?:jpe?g|png)$/
const ACCEPT_IMAGE = 'image/jpeg,image/png'

export type CoverMatchErrorCode = 'download_failed' | 'image_too_large' | 'invalid_candidate'

/**
 * 下载/候选类错误（`CoverFileErrorCode` 不含 download_failed，因此单独定义）
 */
export class CoverMatchError extends Error {
  code: CoverMatchErrorCode

  constructor(code: CoverMatchErrorCode, message: string) {
    super(message)
    this.name = 'CoverMatchError'
    this.code = code
  }
}

interface CoverProvider {
  id: LX.Music.CoverSource
  search: (query: LX.Music.MatchQuery, signal?: AbortSignal) => Promise<LX.Music.CoverCandidate[]>
}

const providers: CoverProvider[] = [
  { id: qq.id, search: qq.search },
  { id: itunes.id, search: itunes.search },
]

const sleep = async(ms: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    BackgroundTimer.setTimeout(resolve, ms)
  })
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

const createQuery = (musicInfo: LX.Music.MusicInfoLocal, keyword?: string): LX.Music.MatchQuery => {
  return createMatchQuery({
    name: musicInfo.name,
    singer: musicInfo.singer,
    albumName: musicInfo.meta.albumName,
    durationSec: parseIntervalToSec(musicInfo.interval),
    fileStem: getFileStem(musicInfo.meta.filePath),
  }, keyword)
}

export interface SearchCoverCandidatesOptions {
  musicInfo: LX.Music.MusicInfoLocal
  keyword?: string
  signal?: AbortSignal
}

/**
 * 搜索在线封面候选：两源并行 → 聚合 → 评分/去重 → 截断 20 条
 */
export const searchCoverCandidates = async({ musicInfo, keyword, signal }: SearchCoverCandidatesOptions): Promise<LX.Music.CoverCandidate[]> => {
  const query = createQuery(musicInfo, keyword)
  if (!query.variants.length) return []

  const abortContext = createAbortContext(signal)
  let results: Array<PromiseSettledResult<LX.Music.CoverCandidate[]>>
  try {
    results = await Promise.allSettled(providers.map(async provider => await provider.search(query, abortContext.signal)))
  } finally {
    abortContext.dispose()
  }

  const candidates: LX.Music.CoverCandidate[] = []
  let failedSources = 0
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      candidates.push(...result.value)
    } else {
      failedSources++
      log.warn(`cover match source ${providers[index].id} failed: ${result.reason?.message ?? result.reason}`)
    }
  })
  if (abortContext.isCanceled() && !candidates.length) return []
  if (!candidates.length && failedSources === providers.length) throw new Error('all cover sources failed')
  return rankCoverCandidates(query, candidates, MAX_RESULT_COUNT)
}

const normalizeContentType = (contentType: string | undefined): string => {
  return (contentType ?? '').split(';')[0].trim().toLowerCase()
}

const isSupportedContentType = (contentType: string): boolean => {
  // QQ 有时返回 image/jpg；webp 一律拒绝
  return JPEG_CONTENT_TYPE_RXP.test(contentType)
}

const getHeader = (headers: Record<string, string | string[]> | undefined, name: string): string => {
  if (!headers) return ''
  const target = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== target) continue
    const value = headers[key]
    return Array.isArray(value) ? value[0] ?? '' : value ?? ''
  }
  return ''
}

/**
 * 候选 URL 白名单校验；QQ 直接用 albummid 重建大图地址，避免使用渲染层传入的任意 URL
 */
const getValidatedCoverUrl = (candidate: LX.Music.CoverCandidate | null | undefined): string => {
  if (!candidate?.id) throw new CoverFileError('invalid_file', 'invalid cover candidate')
  if (candidate.source === 'qq') {
    if (!qq.isAllowedQqCoverUrl(candidate.coverUrl, candidate.id)) throw new CoverFileError('invalid_file', 'invalid cover candidate')
    return qq.buildQqCoverUrl(candidate.id, 500)
  }
  if (candidate.source === 'itunes') {
    if (!itunes.isAllowedItunesCoverUrl(candidate.coverUrl)) throw new CoverFileError('invalid_file', 'invalid cover candidate')
    return candidate.coverUrl
  }
  throw new CoverFileError('invalid_file', 'invalid cover candidate')
}

const downloadOnce = async(url: string): Promise<Uint8Array> => {
  try {
    const response = await httpFetch(url, {
      binary: true,
      timeout: DOWNLOAD_TIMEOUT,
      headers: { Accept: ACCEPT_IMAGE },
    }).promise
    if (response.statusCode !== 200) throw new CoverMatchError('download_failed', `unexpected status: ${response.statusCode}`)
    const headers = response.headers as unknown as Record<string, string | string[]> | undefined
    const contentType = normalizeContentType(getHeader(headers, 'content-type'))
    if (!isSupportedContentType(contentType)) throw new CoverMatchError('download_failed', `unexpected content type: ${contentType || 'unknown'}`)
    const body = response.body as unknown as Uint8Array | null | undefined
    if (body == null || body.length === 0) throw new CoverMatchError('download_failed', 'empty image body')
    if (body.length > MAX_IMAGE_BYTES) throw new CoverMatchError('image_too_large', 'image body too large')
    return body
  } catch (error) {
    if (error instanceof CoverMatchError) throw error
    throw new CoverMatchError('download_failed', error instanceof Error ? error.message : String(error))
  }
}

/**
 * 下载封面：10s 超时、≤8MB、最多 1 次重试（300ms）；体积超限不重试
 */
const downloadCoverImage = async(url: string): Promise<Uint8Array> => {
  let lastError: unknown
  for (let attempt = 0; attempt <= DOWNLOAD_RETRY; attempt++) {
    try {
      return await downloadOnce(url)
    } catch (error) {
      lastError = error
      if (error instanceof CoverMatchError && error.code === 'image_too_large') throw error
      if (attempt < DOWNLOAD_RETRY) await sleep(DOWNLOAD_RETRY_DELAY)
    }
  }
  if (lastError instanceof CoverMatchError) throw lastError
  throw new CoverMatchError('download_failed', lastError instanceof Error ? lastError.message : String(lastError))
}

export interface ApplyCoverCandidateOptions {
  musicInfo: LX.Music.MusicInfoLocal
  candidate: LX.Music.CoverCandidate
}

/**
 * 应用候选：路径/候选校验 → 下载 → magic/尺寸校验 → 写同名图（备份/原子写由 coverFile 负责）
 */
export const applyCoverCandidate = async({ musicInfo, candidate }: ApplyCoverCandidateOptions): Promise<LX.Music.CoverApplyResult> => {
  const filePath = musicInfo?.meta?.filePath
  if (!filePath || checkCoverMatchablePath(filePath) !== 'ok') throw new CoverFileError('invalid_file', 'invalid music file path')
  if (!await existsFile(filePath)) throw new CoverFileError('invalid_file', 'music file not found')

  const coverUrl = getValidatedCoverUrl(candidate)
  const data = await downloadCoverImage(coverUrl)
  validateImageData(data)
  return applyCoverImage(filePath, data)
}

/**
 * 读取歌曲同名封面状态；路径不可写时返回空状态（不碰 fs）
 */
export const getCoverState = async(musicInfo: LX.Music.MusicInfoLocal): Promise<LX.Music.CoverState> => {
  const filePath = musicInfo?.meta?.filePath
  if (!filePath || checkCoverMatchablePath(filePath) !== 'ok') {
    return { imageExists: false, backupExists: false }
  }
  return getCoverFileState(filePath)
}

/**
 * 回退到备份封面；路径不可写时直接返回 false（不碰 fs）
 */
export const rollbackCover = async(musicInfo: LX.Music.MusicInfoLocal): Promise<boolean> => {
  const filePath = musicInfo?.meta?.filePath
  if (!filePath || checkCoverMatchablePath(filePath) !== 'ok') return false
  return rollbackCoverFile(filePath)
}

/**
 * 若当前播放的正是这首歌，重新读取封面并刷新显示（不重启播放）
 */
export const refreshPlayingCover = async(musicInfo?: LX.Music.MusicInfoLocal): Promise<boolean> => {
  const playing = playerState.playMusicInfo
  const playingInfo = playing.musicInfo
  if (!playingInfo) return false
  if (musicInfo && playingInfo.id !== musicInfo.id) return false
  try {
    const pic = await getPicPath({ musicInfo: playingInfo, listId: playing.listId })
    if (playerState.playMusicInfo.musicInfo?.id !== playingInfo.id) return false
    if (!pic) return false
    setMusicInfo({ pic })
    global.app_event.picUpdated()
    return true
  } catch (error: any) {
    log.warn(`refresh playing cover failed: ${error?.message ?? error}`)
    return false
  }
}
