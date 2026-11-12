import BackgroundTimer from 'react-native-background-timer'
import { version } from '../../../../package.json'
import { httpFetch } from '@/utils/request'
import { log } from '@/utils/log'
import { validateLyricText } from '../validateLyric'

/**
 * LRCLIB 数据源（主源，免 key）
 * 接口文档：https://lrclib.net/docs
 *
 * 两段式：search 只返回候选元数据（同时把内联歌词缓存进进程内 LRU），
 * 用户选中候选后再由 getLyric 取词。
 */

export const id = 'lrclib' as const

const API_BASE = 'https://lrclib.net/api'
const USER_AGENT = `LXMusicLocal/${version} (+https://github.com/lyswhut/lx-music-desktop)`
// 串行请求，间隔 >= 250ms
const MIN_REQUEST_INTERVAL = 250
const REQUEST_TIMEOUT = 10000
const MAX_RESPONSE_SIZE = 2 * 1024 * 1024
const MAX_RETRY = 2
const MAX_KEYWORD_REQUESTS = 3
// 进程内歌词缓存（搜索结果已含歌词，选中时直接用）
const LYRIC_CACHE_LIMIT = 50

interface LrclibItem {
  id?: number | string
  trackName?: string
  artistName?: string
  albumName?: string
  duration?: number
  instrumental?: boolean
  plainLyrics?: string | null
  syncedLyrics?: string | null
}

interface CachedLyric {
  syncedLyrics: string
  plainLyrics: string
}

interface HttpResult {
  statusCode: number
  headers?: Record<string, string | string[]>
  body: unknown
}

const lyricCache = new Map<string, CachedLyric>()
let lastRequestAt = 0

const sleep = async(ms: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    BackgroundTimer.setTimeout(resolve, ms)
  })
}

const waitRequestSlot = async() => {
  const wait = lastRequestAt + MIN_REQUEST_INTERVAL - Date.now()
  if (wait > 0) await sleep(wait)
  // eslint-disable-next-line require-atomic-updates
  lastRequestAt = Date.now()
}

const getRetryDelay = (headers?: Record<string, string | string[]>): number => {
  let base = 1000
  if (headers) {
    const raw = headers['retry-after'] ?? headers['Retry-After']
    const value = Array.isArray(raw) ? raw[0] : raw
    const seconds = Number(value)
    if (Number.isFinite(seconds) && seconds > 0) base = seconds * 1000
  }
  // Retry-After + <=30% 抖动，上限 5s
  return Math.min(base + base * 0.3 * Math.random(), 5000)
}

const putLyricCache = (id: string, syncedLyrics?: string | null, plainLyrics?: string | null) => {
  if (!syncedLyrics && !plainLyrics) return
  if (lyricCache.size >= LYRIC_CACHE_LIMIT) {
    const firstKey = lyricCache.keys().next().value
    if (firstKey != null) lyricCache.delete(firstKey)
  }
  lyricCache.set(id, {
    syncedLyrics: syncedLyrics?.trim() ?? '',
    plainLyrics: plainLyrics?.trim() ?? '',
  })
}

const requestOnce = async(url: string, signal?: AbortSignal): Promise<HttpResult> => {
  await waitRequestSlot()
  const request = httpFetch(url, {
    timeout: REQUEST_TIMEOUT,
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    },
  })
  const cancel = () => { request.cancelHttp() }
  let aborted = false
  const handleAbort = () => {
    aborted = true
    cancel()
  }
  if (signal?.aborted) handleAbort()
  else signal?.addEventListener?.('abort', handleAbort)

  try {
    const resp = await request.promise
    if (aborted) throw new Error('aborted')
    const body = resp.body
    // 响应体上限 2MB（请求只包含歌名/歌手/专辑，正常响应远小于此值）
    const bodySize = typeof body === 'string' ? body.length : JSON.stringify(body ?? '').length
    if (bodySize > MAX_RESPONSE_SIZE) throw new Error('response body too large')
    return {
      statusCode: resp.statusCode,
      headers: resp.headers,
      body,
    }
  } finally {
    signal?.removeEventListener?.('abort', handleAbort)
  }
}

/**
 * 先按状态码处理 429/503 退避，再解析 JSON。
 * /api/get 的 400 返回 text/plain，因此这里不依赖 content-type、也不直接 JSON.parse 响应对象。
 */
const requestApi = async(url: string, signal?: AbortSignal): Promise<unknown> => {
  let lastError: unknown
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    if (signal?.aborted) throw new Error('aborted')
    const resp = await requestOnce(url, signal)
    if (resp.statusCode === 429 || resp.statusCode === 503) {
      lastError = new Error(`HTTP ${resp.statusCode}`)
      if (attempt >= MAX_RETRY) throw lastError
      await sleep(getRetryDelay(resp.headers))
      continue
    }
    if (resp.statusCode < 200 || resp.statusCode >= 300) {
      // 400/404 的 body 可能是 text/plain 或 JSON，错误信息只用于日志
      const detail = typeof resp.body === 'string' ? resp.body : ''
      throw new Error(`HTTP ${resp.statusCode}${detail ? `: ${detail.substring(0, 120)}` : ''}`)
    }
    return resp.body
  }
  if (lastError instanceof Error) throw lastError
  throw new Error('request failed')
}

const parseJsonBody = <T>(body: unknown): T => {
  if (typeof body === 'string') return JSON.parse(body) as T
  return body as T
}

const normalizeAlbumName = (albumName?: string | null): string => {
  const value = albumName?.trim() ?? ''
  return value.toLowerCase() === 'null' ? '' : value
}

const createSearchUrl = (params: Record<string, string>) => {
  const searchParams = Object.entries(params)
    .filter(([, value]) => value.trim())
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value.trim())}`)
  return `${API_BASE}/search?${searchParams.join('&')}`
}

const toCandidate = (item: LrclibItem): LX.Music.LyricsCandidate | null => {
  if (item.id == null) return null
  putLyricCache(String(item.id), item.syncedLyrics, item.plainLyrics)
  return {
    source: 'lrclib',
    id: String(item.id),
    name: item.trackName?.trim() ?? '',
    singer: item.artistName?.trim() ?? '',
    albumName: normalizeAlbumName(item.albumName),
    durationSec: typeof item.duration === 'number' && Number.isFinite(item.duration) ? item.duration : null,
    // 两段式：取词前未知，选中候选后由 getLyric 确定
    hasSynced: null,
    instrumental: item.instrumental === true,
    score: 0,
  }
}

const collectItems = (items: LrclibItem[], result: LX.Music.LyricsCandidate[], seen: Set<string>) => {
  for (const item of items) {
    const candidate = toCandidate(item)
    if (!candidate || seen.has(candidate.id)) continue
    seen.add(candidate.id)
    result.push(candidate)
  }
}

/**
 * 搜索歌词候选
 * 先按结构化字段（track_name/artist_name/album_name）请求，结果不足时按 variants 顺序回退到 q 关键字搜索。
 */
export const search = async(query: LX.Music.MatchQuery, signal?: AbortSignal): Promise<LX.Music.LyricsCandidate[]> => {
  const result: LX.Music.LyricsCandidate[] = []
  const seen = new Set<string>()
  let successCount = 0
  let lastError: unknown
  const defaultKeyword = `${query.name} ${query.singer}`.trim()
  const firstVariant = query.variants[0]?.trim() ?? ''
  // 用户手动改过关键词时不要再走结构化查询，否则会把用户的关键词忽略掉
  const hasCustomKeyword = !!firstVariant && firstVariant !== defaultKeyword && firstVariant !== query.name

  try {
    if (query.name && !hasCustomKeyword) {
      const url = createSearchUrl({
        track_name: query.name,
        artist_name: query.singer,
        album_name: query.albumName,
      })
      const body = await requestApi(url, signal)
      const items = parseJsonBody<LrclibItem[]>(body)
      successCount++
      if (Array.isArray(items)) collectItems(items, result, seen)
    }
  } catch (error: any) {
    if (signal?.aborted) return result
    lastError = error
    log.warn(`LRCLIB structured search failed: ${error?.message ?? error}`)
  }

  // 设计 §3.1：结构化结果非空即不再触发副作用更大的 q 回退
  if (result.length > 0) return result

  const keywordVariants = [query.variants[0], query.name, ...query.variants]
    .filter((variant): variant is string => typeof variant === 'string' && !!variant.trim())
  const used = new Set<string>()
  let requestCount = 0
  for (const keyword of keywordVariants) {
    if (signal?.aborted) break
    if (used.has(keyword) || requestCount >= MAX_KEYWORD_REQUESTS) continue
    used.add(keyword)
    requestCount++
    try {
      const body = await requestApi(createSearchUrl({ q: keyword }), signal)
      const items = parseJsonBody<LrclibItem[]>(body)
      successCount++
      if (Array.isArray(items)) collectItems(items, result, seen)
    } catch (error: any) {
      if (signal?.aborted) break
      lastError = error
      log.warn(`LRCLIB keyword search failed: ${error?.message ?? error}`)
    }
    if (result.length > 0) break
  }

  // 所有请求都失败（非「成功但 0 条」）时向上抛出，由编排层判断是否全部源失败
  if (!result.length && successCount === 0 && lastError) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }
  return result
}

/**
 * 取候选歌词正文（优先使用 search 阶段缓存，未命中再 GET /api/get/{id}）
 */
export const getLyric = async(candidate: LX.Music.LyricsCandidate, signal?: AbortSignal): Promise<{ lyric: string, isSynced: boolean } | null> => {
  // 设计 §3.1：instrumental === true 的候选仍可展示（标注「纯音乐」），但禁止应用
  if (candidate.instrumental) return null
  let cached = lyricCache.get(candidate.id)
  if (!cached) {
    const body = await requestApi(`${API_BASE}/get/${encodeURIComponent(candidate.id)}`, signal)
    const item = parseJsonBody<LrclibItem>(body)
    putLyricCache(candidate.id, item.syncedLyrics, item.plainLyrics)
    cached = lyricCache.get(candidate.id)
  }
  if (!cached) return null
  const lyric = cached.syncedLyrics || cached.plainLyrics
  if (!lyric) return null
  return validateLyricText(lyric)
}
