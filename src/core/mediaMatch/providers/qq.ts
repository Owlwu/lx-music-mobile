import BackgroundTimer from 'react-native-background-timer'
import { log } from '@/utils/log'
import { isInstrumentalName } from '@/utils/mediaMatch/query'
import { validateLyricText } from '../validateLyric'

/**
 * QQ 音乐数据源（实验性）
 *
 * 依据 `docs/source/qq-provider.md`（2026-11-11 实测）：
 * - 搜索：`c.y.qq.com/soso/fcgi-bin/client_search_cp`（免 UA/Referer/Cookie）
 * - 歌词：`c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg`（必须带 Referer: https://y.qq.com/）
 * - HTTP 恒 200，错误在 body 的 code/retcode 里；Content-Type 不可信，统一 res.text() + JSON.parse
 * - nobase64=1 直接返回明文；不发送任何登录 Cookie
 */

export const id = 'qq' as const

const SEARCH_URL = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp'
const LYRIC_URL = 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg'
const REFERER = 'https://y.qq.com/'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const REQUEST_TIMEOUT = 10000
const MAX_RESPONSE_SIZE = 2 * 1024 * 1024
const MIN_REQUEST_INTERVAL = 250

interface QqSongItem {
  songmid?: string
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

interface QqLyricResponse {
  code?: number
  retcode?: number
  lyric?: string
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

const requestJson = async<T>(url: string, signal?: AbortSignal): Promise<T> => {
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
      },
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    if (text.length > MAX_RESPONSE_SIZE) throw new Error('response body too large')
    return JSON.parse(stripJsonp(text)) as T
  } catch (error: any) {
    if (timedOut) throw new Error('request timeout')
    throw error
  } finally {
    BackgroundTimer.clearTimeout(timer)
    signal?.removeEventListener?.('abort', handleAbort)
  }
}

const getCode = (json: { code?: number, retcode?: number }): number => json.code ?? json.retcode ?? -1

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

const hasNonAsciiChar = (text: string): boolean => {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x7F) return true
  }
  return false
}

/**
 * nobase64=1 时应为明文；这里兼容历史 base64 返回（接口版本差异）
 * 判定与桌面 qqParse 对齐：解码结果含 `[`/`]` 或含非 ASCII 字符即采用，再交给有效性校验
 */
const decodeLyricRaw = (raw: string): string => {
  let lyric = raw.trim()
  if (!lyric.includes('[') && !lyric.includes('\n') && /^[A-Za-z0-9+/=\s]+$/.test(lyric) && lyric.length > 40) {
    try {
      const decoded = Buffer.from(lyric.replace(/\s/g, ''), 'base64').toString('utf8')
      if (decoded.includes('[') || decoded.includes(']') || hasNonAsciiChar(decoded)) lyric = decoded
    } catch {}
  }
  return htmlUnescape(lyric)
}

const mapSongItem = (item: QqSongItem): LX.Music.LyricsCandidate | null => {
  if (!item.songmid) return null
  const name = item.songname?.trim() ?? ''
  const singer = (item.singer ?? [])
    .map(songSinger => songSinger.name?.trim())
    .filter((value): value is string => !!value)
    .join(' / ')
  const interval = Number(item.interval)
  return {
    source: 'qq',
    id: String(item.songmid),
    name,
    singer,
    albumName: item.albumname?.trim() ?? '',
    durationSec: Number.isFinite(interval) && interval > 0 ? interval : null,
    // 取词后才能确定
    hasSynced: null,
    instrumental: isInstrumentalName(name),
    score: 0,
  }
}

const createSearchUrl = (keyword: string): string => {
  return `${SEARCH_URL}?format=json&n=10&p=1&w=${encodeURIComponent(keyword)}&cr=1&g_tk=5381`
}

/**
 * 搜索歌词候选（只返回元数据，歌词按需由 getLyric 获取）
 */
export const search = async(query: LX.Music.MatchQuery, signal?: AbortSignal): Promise<LX.Music.LyricsCandidate[]> => {
  const startAt = Date.now()
  const keywords = [query.variants[0], `${query.name} ${query.singer}`.trim(), query.name]
    .filter((keyword): keyword is string => typeof keyword === 'string' && !!keyword.trim())
  const used = new Set<string>()
  let successCount = 0
  let lastError: unknown

  for (const keyword of keywords) {
    if (signal?.aborted) return []
    if (used.has(keyword)) continue
    used.add(keyword)
    try {
      const json = await requestJson<QqSearchResponse>(createSearchUrl(keyword), signal)
      const code = getCode(json)
      if (code !== 0) {
        lastError = new Error(`QQ search code=${code}`)
        log.warn(`QQ search failed: code=${code}, keyword=${keyword}`)
        continue
      }
      successCount++
      const list = json.data?.song?.list
      if (!Array.isArray(list)) continue
      const result = list.map(mapSongItem).filter((item): item is LX.Music.LyricsCandidate => item != null)
      log.info(`media match source qq: ${result.length} results in ${Date.now() - startAt}ms`)
      if (result.length) return result
    } catch (error: any) {
      if (signal?.aborted) return []
      lastError = error
      log.warn(`QQ search error: ${error?.message ?? error}`)
    }
  }
  // 所有请求都失败（非「成功但 0 条」）时向上抛出
  if (successCount === 0 && lastError) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }
  log.info(`media match source qq: 0 results in ${Date.now() - startAt}ms`)
  return []
}

/**
 * 按 songmid 获取歌词（-1901/占位文本/无有效歌词均返回 null）
 */
export const getLyric = async(candidate: LX.Music.LyricsCandidate, signal?: AbortSignal): Promise<{ lyric: string, isSynced: boolean } | null> => {
  const url = `${LYRIC_URL}?songmid=${encodeURIComponent(candidate.id)}&format=json&nobase64=1&g_tk=5381`
  try {
    const json = await requestJson<QqLyricResponse>(url, signal)
    const code = getCode(json)
    if (code !== 0) {
      log.info(`media match source qq: get lyric code=${code} (id=${candidate.id})`)
      return null
    }
    if (typeof json.lyric !== 'string' || !json.lyric) return null
    return validateLyricText(decodeLyricRaw(json.lyric))
  } catch (error: any) {
    if (signal?.aborted) return null
    log.warn(`QQ get lyric failed: ${error?.message ?? error}`)
    return null
  }
}
