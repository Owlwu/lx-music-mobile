import BackgroundTimer from 'react-native-background-timer'
import { log } from '@/utils/log'

/**
 * iTunes 封面源（回退源）
 *
 * - 查询含 CJK 时用 `country=jp`，否则 `us`；0 结果换另一 store 重试一次
 * - `artworkUrl100` 的 `100x100bb` 换成 `600x600bb` 作为大图，原 100 图作缩略图
 * - 不发送任何 Cookie；失败静默降级，由编排层 allSettled 处理
 */

export const id = 'itunes' as const

const SEARCH_URL = 'https://itunes.apple.com/search'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const REQUEST_TIMEOUT = 10000
const MAX_RESPONSE_SIZE = 4 * 1024 * 1024
// 串行请求间隔 >= 300ms
const MIN_REQUEST_INTERVAL = 300
const MAX_KEYWORDS = 2
const LIMIT = 15

// CJK（日文假名/汉字扩展/汉字/兼容汉字/韩文音节）
const cjkRxp = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/
const itunesCoverUrlRxp = /^https:\/\/(?:[a-z0-9-]+\.)+mzstatic\.com\/image\/thumb\/[^\s]+$/i

interface ItunesSongItem {
  collectionId?: number | string
  artworkUrl100?: string
  trackName?: string
  artistName?: string
  collectionName?: string
  trackTimeMillis?: number | string
}

interface ItunesSearchResponse {
  resultCount?: number
  results?: ItunesSongItem[]
}

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

/**
 * 歌名/歌手/专辑含 CJK 字符时用日本 store（华语曲目在 jp 命中率明显更高，cn store 常为 0）
 */
export const getItunesStore = (query: LX.Music.MatchQuery): 'jp' | 'us' => {
  return cjkRxp.test([query.name, query.singer, query.albumName].join(' ')) ? 'jp' : 'us'
}

/**
 * 100x100bb 缩略图地址 → 600x600bb 大图地址
 */
export const buildItunesCoverUrl = (artworkUrl100: string): string => {
  return artworkUrl100.replace('100x100bb', '600x600bb')
}

/**
 * 候选 URL 白名单：仅允许 Apple 的 mzstatic 图片地址
 */
export const isAllowedItunesCoverUrl = (url: string): boolean => {
  return typeof url === 'string' && itunesCoverUrlRxp.test(url)
}

const createSearchUrl = (keyword: string, country: 'jp' | 'us'): string => {
  return `${SEARCH_URL}?term=${encodeURIComponent(keyword)}&entity=song&limit=${LIMIT}&country=${country}`
}

const requestJson = async(url: string, signal?: AbortSignal): Promise<ItunesSearchResponse> => {
  await waitRequestSlot()
  const controller = new AbortController()
  let timedOut = false
  const timer = BackgroundTimer.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, REQUEST_TIMEOUT)
  const handleAbort = () => { controller.abort() }
  if (signal?.aborted) handleAbort()
  else signal?.addEventListener?.('abort', handleAbort)

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    if (text.length > MAX_RESPONSE_SIZE) throw new Error(`body too large (${text.length})`)
    return JSON.parse(text) as ItunesSearchResponse
  } catch (error: any) {
    if (timedOut) throw new Error('request timeout')
    throw error
  } finally {
    BackgroundTimer.clearTimeout(timer)
    signal?.removeEventListener?.('abort', handleAbort)
  }
}

const mapSongItem = (item: ItunesSongItem): LX.Music.CoverCandidate | null => {
  const artworkUrl100 = item.artworkUrl100?.trim() ?? ''
  if (!artworkUrl100) return null
  const name = item.trackName?.trim() ?? ''
  if (!name) return null
  const collectionId = Number(item.collectionId)
  if (!Number.isFinite(collectionId)) return null
  const trackTimeMillis = Number(item.trackTimeMillis)
  return {
    source: 'itunes',
    id: String(collectionId),
    name,
    singer: item.artistName?.trim() ?? '',
    albumName: item.collectionName?.trim() ?? '',
    durationSec: Number.isFinite(trackTimeMillis) && trackTimeMillis > 0 ? trackTimeMillis / 1000 : null,
    coverUrl: buildItunesCoverUrl(artworkUrl100),
    thumbnailUrl: artworkUrl100,
    score: 0,
  }
}

const parseSearchResponse = (json: ItunesSearchResponse): LX.Music.CoverCandidate[] => {
  const list = json.results
  if (!Array.isArray(list)) return []
  const result: LX.Music.CoverCandidate[] = []
  const seen = new Set<string>()
  for (const item of list) {
    const candidate = mapSongItem(item)
    if (!candidate || seen.has(candidate.id)) continue
    seen.add(candidate.id)
    result.push(candidate)
  }
  return result
}

const requestStore = async(keyword: string, country: 'jp' | 'us', signal?: AbortSignal): Promise<LX.Music.CoverCandidate[]> => {
  const json = await requestJson(createSearchUrl(keyword, country), signal)
  return parseSearchResponse(json)
}

/**
 * 搜索封面候选：优先 store 0 结果时换另一 store 重试一次；最多 2 个 query variant
 */
export const search = async(query: LX.Music.MatchQuery, signal?: AbortSignal): Promise<LX.Music.CoverCandidate[]> => {
  const startAt = Date.now()
  const preferredStore = getItunesStore(query)
  const fallbackStore = preferredStore === 'jp' ? 'us' : 'jp'
  const keywords = query.variants.slice(0, MAX_KEYWORDS)
  const used = new Set<string>()
  let successCount = 0
  let lastError: unknown

  const searchStore = async(keyword: string, country: 'jp' | 'us'): Promise<LX.Music.CoverCandidate[]> => {
    try {
      const result = await requestStore(keyword, country, signal)
      successCount++
      return result
    } catch (error: any) {
      if (signal?.aborted) throw error
      lastError = error
      log.warn(`cover match source itunes: error=${error?.message ?? error}, count=0, cost=${Date.now() - startAt}ms`)
      return []
    }
  }

  try {
    for (const keyword of keywords) {
      if (signal?.aborted) return []
      if (used.has(keyword)) continue
      used.add(keyword)
      let result = await searchStore(keyword, preferredStore)
      if (!result.length && !signal?.aborted) result = await searchStore(keyword, fallbackStore)
      if (result.length) {
        log.info(`cover match source itunes: count=${result.length}, cost=${Date.now() - startAt}ms`)
        return result
      }
    }
  } catch (error) {
    if (signal?.aborted) return []
    throw error
  }

  // 所有请求都失败（非「成功但 0 条」）时向上抛出，由编排层降级
  if (successCount === 0 && lastError) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }
  log.info(`cover match source itunes: count=0, cost=${Date.now() - startAt}ms`)
  return []
}
