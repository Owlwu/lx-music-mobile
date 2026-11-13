import BackgroundTimer from 'react-native-background-timer'
import { log } from '@/utils/log'

/**
 * QQ 音乐封面源（主源）
 *
 * 复用一期 QQ 搜索 `client_search_cp`（`docs/source/qq-provider.md` 实测）：
 * - 接口免 UA/Referer/Cookie，但带上 UA/Referer 更稳定；**不发送任何登录 Cookie**
 * - HTTP 恒 200，错误在 body 的 code 里；Content-Type 不可信，统一 res.text() + JSON.parse
 * - 从结果里取 `albummid` 拼封面地址：R500 大图 / R150 缩略图
 * - 封面请求显式 Accept image/jpeg,image/png（默认会返回 webp）
 */

export const id = 'qq' as const

const SEARCH_URL = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp'
const COVER_URL = 'https://y.qq.com/music/photo_new/'
const REFERER = 'https://y.qq.com/'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const REQUEST_TIMEOUT = 10000
const MAX_RESPONSE_SIZE = 2 * 1024 * 1024
// 串行请求间隔 >= 300ms
const MIN_REQUEST_INTERVAL = 300
const MAX_KEYWORDS = 2

const qqAlbummidRxp = /^[0-9A-Za-z]+$/

interface QqSongItem {
  albummid?: string
  songname?: string
  singer?: Array<{ name?: string }>
  albumname?: string
  interval?: number | string
}

interface QqSearchResponse {
  code?: number
  data?: {
    song?: {
      list?: QqSongItem[]
    }
  }
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

const stripJsonp = (text: string): string => {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) return trimmed.substring(start, end + 1)
  return trimmed
}

const htmlUnescape = (text: string): string => {
  return text
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/**
 * QQ 封面地址：500 为大图（R500 实测真封面），150 为缩略图
 */
export const buildQqCoverUrl = (albummid: string, size: 150 | 500): string => {
  return `${COVER_URL}T002R${size}x${size}M000${albummid}.jpg`
}

/**
 * 候选 URL 白名单：用 albummid 重建合法地址做精确比对，避免渲染层传入任意 URL
 */
export const isAllowedQqCoverUrl = (url: string, albummid: string): boolean => {
  if (typeof url !== 'string' || typeof albummid !== 'string') return false
  const normalized = albummid.trim()
  if (!qqAlbummidRxp.test(normalized)) return false
  return url === buildQqCoverUrl(normalized, 500) || url === buildQqCoverUrl(normalized, 150)
}

const createSearchUrl = (keyword: string): string => {
  return `${SEARCH_URL}?format=json&n=10&p=1&w=${encodeURIComponent(keyword)}&cr=1&g_tk=5381`
}

const requestJson = async(url: string, signal?: AbortSignal): Promise<QqSearchResponse> => {
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
        Referer: REFERER,
        Accept: 'application/json',
      },
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    if (text.length > MAX_RESPONSE_SIZE) throw new Error(`body too large (${text.length})`)
    return JSON.parse(stripJsonp(text)) as QqSearchResponse
  } catch (error: any) {
    if (timedOut) throw new Error('request timeout')
    throw error
  } finally {
    BackgroundTimer.clearTimeout(timer)
    signal?.removeEventListener?.('abort', handleAbort)
  }
}

const mapSongItem = (item: QqSongItem): LX.Music.CoverCandidate | null => {
  const albummid = item.albummid?.trim() ?? ''
  if (!albummid || !qqAlbummidRxp.test(albummid)) return null
  const name = htmlUnescape(item.songname ?? '').trim()
  if (!name) return null
  const singer = (item.singer ?? [])
    .map(songSinger => htmlUnescape(songSinger.name ?? '').trim())
    .filter((value): value is string => !!value)
    .join(' / ')
  const interval = Number(item.interval)
  return {
    source: 'qq',
    id: albummid,
    name,
    singer,
    albumName: htmlUnescape(item.albumname ?? '').trim(),
    durationSec: Number.isFinite(interval) && interval > 0 ? interval : null,
    coverUrl: buildQqCoverUrl(albummid, 500),
    thumbnailUrl: buildQqCoverUrl(albummid, 150),
    score: 0,
  }
}

const parseSearchResponse = (json: QqSearchResponse): LX.Music.CoverCandidate[] => {
  const list = json.data?.song?.list
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

/**
 * 搜索封面候选（最多 2 个 query variant；同 albummid 去重）
 */
export const search = async(query: LX.Music.MatchQuery, signal?: AbortSignal): Promise<LX.Music.CoverCandidate[]> => {
  const startAt = Date.now()
  const keywords = query.variants.slice(0, MAX_KEYWORDS)
  const used = new Set<string>()
  let successCount = 0
  let lastError: unknown

  for (const keyword of keywords) {
    if (signal?.aborted) return []
    if (used.has(keyword)) continue
    used.add(keyword)
    try {
      const json = await requestJson(createSearchUrl(keyword), signal)
      const code = json.code ?? -1
      if (code !== 0) {
        lastError = new Error(`QQ search code=${code}`)
        log.warn(`cover match source qq: code=${code}, count=0, cost=${Date.now() - startAt}ms`)
        continue
      }
      successCount++
      const result = parseSearchResponse(json)
      if (result.length) {
        log.info(`cover match source qq: count=${result.length}, cost=${Date.now() - startAt}ms`)
        return result
      }
    } catch (error: any) {
      if (signal?.aborted) return []
      lastError = error
      log.warn(`cover match source qq: error=${error?.message ?? error}, count=0, cost=${Date.now() - startAt}ms`)
    }
  }

  // 所有请求都失败（非「成功但 0 条」）时向上抛出，由编排层降级
  if (successCount === 0 && lastError) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }
  log.info(`cover match source qq: count=0, cost=${Date.now() - startAt}ms`)
  return []
}
