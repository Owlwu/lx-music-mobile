import BackgroundTimer from 'react-native-background-timer'
import { httpFetch } from '@/utils/request'
import { log } from '@/utils/log'
import { isInstrumentalName } from '@/utils/mediaMatch/query'
import { sanitizeExtendedLyric } from '@/utils/mediaMatch/lrcText'
import { validateLyricText } from '../validateLyric'

/**
 * 网易云音乐数据源（非官方、无 key）
 *
 * 依据 `docs/phase4-lyrics-translation-contract.md` §2（2026-11-13 实测）：
 * - 搜索：`music.163.com/api/search/get/web`（必须带桌面 UA + Referer，无 Cookie）
 * - 取词：`music.163.com/api/song/lyric?id=&lv=-1&kv=-1&tv=-1&rv=-1`
 *   `tlyric` 为行级中文翻译、`romalrc`/`yromalrc` 为行级罗马音
 * - HTTP 状态与业务 code 双重判断；只记 source/cost/count/code，不打印歌词/URL 正文
 */

export const id = 'netease' as const

const SEARCH_URL = 'https://music.163.com/api/search/get/web'
const LYRIC_URL = 'https://music.163.com/api/song/lyric'
const REFERER = 'https://music.163.com/'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
// 串行请求，间隔 >= 300ms
const MIN_REQUEST_INTERVAL = 300
const REQUEST_TIMEOUT = 10000
const MAX_RESPONSE_SIZE = 4 * 1024 * 1024
// 关键词变体最多请求 2 个，某关键词有结果即返回
const MAX_KEYWORD_REQUESTS = 2

interface NeteaseArtist {
  name?: string
}

interface NeteaseSongItem {
  id?: number | string
  name?: string
  artists?: NeteaseArtist[]
  album?: { name?: string }
  duration?: number
}

interface NeteaseSearchResponse {
  code?: number
  result?: {
    songs?: NeteaseSongItem[]
  }
}

interface NeteaseLyricResponse {
  code?: number
  lrc?: { lyric?: string }
  tlyric?: { lyric?: string }
  romalrc?: { lyric?: string }
  yromalrc?: { lyric?: string }
  nolyric?: boolean
  uncollected?: boolean
}

interface HttpResult {
  statusCode: number
  body: unknown
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

const requestOnce = async(url: string, signal?: AbortSignal): Promise<HttpResult> => {
  await waitRequestSlot()
  const request = httpFetch(url, {
    timeout: REQUEST_TIMEOUT,
    headers: {
      'User-Agent': USER_AGENT,
      Referer: REFERER,
      Accept: 'application/json',
    },
  })
  let aborted = false
  const handleAbort = () => {
    aborted = true
    request.cancelHttp()
  }
  if (signal?.aborted) handleAbort()
  else signal?.addEventListener?.('abort', handleAbort)

  try {
    const resp = await request.promise
    if (aborted) throw new Error('aborted')
    if (resp.statusCode < 200 || resp.statusCode >= 300) throw new Error(`HTTP ${resp.statusCode}`)
    const body = resp.body
    // 响应体上限 4MB（只包含歌曲元数据/歌词，正常响应远小于此值）
    const bodySize = typeof body === 'string' ? body.length : JSON.stringify(body ?? '').length
    if (bodySize > MAX_RESPONSE_SIZE) throw new Error('response body too large')
    return { statusCode: resp.statusCode, body }
  } finally {
    signal?.removeEventListener?.('abort', handleAbort)
  }
}

/**
 * 请求 JSON；httpFetch 已按状态处理超时/取消，这里再统一解析文本与 JSON 对象两种 body
 */
const requestJson = async<T>(url: string, signal?: AbortSignal): Promise<T> => {
  const resp = await requestOnce(url, signal)
  return typeof resp.body === 'string' ? JSON.parse(resp.body) as T : resp.body as T
}

const mapSongItem = (item: NeteaseSongItem): LX.Music.LyricsCandidate | null => {
  if (item.id == null) return null
  const name = htmlUnescape(item.name ?? '').trim()
  const singer = (item.artists ?? [])
    .map(artist => artist.name?.trim())
    .filter((value): value is string => !!value)
    .join(' / ')
  const durationMs = Number(item.duration)
  return {
    source: 'netease',
    id: String(item.id),
    name,
    singer,
    albumName: item.album?.name?.trim() ?? '',
    durationSec: Number.isFinite(durationMs) && durationMs > 0 ? durationMs / 1000 : null,
    // 取词后才能确定
    hasSynced: null,
    instrumental: isInstrumentalName(name),
    score: 0,
  }
}

const createSearchUrl = (keyword: string): string => {
  return `${SEARCH_URL}?csrf_token=&s=${encodeURIComponent(keyword)}&type=1&offset=0&limit=10`
}

const createLyricUrl = (songId: string): string => {
  return `${LYRIC_URL}?id=${encodeURIComponent(songId)}&lv=-1&kv=-1&tv=-1&rv=-1`
}

/**
 * 搜索歌词候选（只返回元数据）：
 * 关键词取 `query.variants` 前 2 个，某关键词有结果即返回；全部请求失败且 0 条时抛错。
 */
export const search = async(query: LX.Music.MatchQuery, signal?: AbortSignal): Promise<LX.Music.LyricsCandidate[]> => {
  const startAt = Date.now()
  const keywords: string[] = []
  for (const variant of query.variants.slice(0, MAX_KEYWORD_REQUESTS)) {
    const keyword = variant?.trim()
    if (keyword && !keywords.includes(keyword)) keywords.push(keyword)
  }

  let successCount = 0
  let lastError: unknown
  for (const keyword of keywords) {
    if (signal?.aborted) return []
    try {
      const json = await requestJson<NeteaseSearchResponse>(createSearchUrl(keyword), signal)
      const code = json.code ?? -1
      if (code !== 200) {
        lastError = new Error(`netease search failed: code=${code}`)
        log.warn(`media match source netease: search code=${code}`)
        continue
      }
      successCount++
      const songs = json.result?.songs
      if (!Array.isArray(songs)) continue
      const result: LX.Music.LyricsCandidate[] = []
      const seen = new Set<string>()
      for (const item of songs) {
        const candidate = mapSongItem(item)
        if (!candidate || seen.has(candidate.id)) continue
        seen.add(candidate.id)
        result.push(candidate)
      }
      if (result.length) {
        log.info(`media match source netease: ${result.length} results in ${Date.now() - startAt}ms`)
        return result
      }
    } catch (error: any) {
      if (signal?.aborted) return []
      lastError = error
      log.warn(`media match source netease: search failed: ${error?.message ?? error}`)
    }
  }
  // 所有请求都失败（非「成功但 0 条」）时向上抛出，由编排层 allSettled 降级
  if (successCount === 0 && lastError) throw lastError instanceof Error ? lastError : new Error(String(lastError))
  log.info(`media match source netease: 0 results in ${Date.now() - startAt}ms`)
  return []
}

/**
 * 按歌曲 id 取词：主歌词用 validateLyricText 校验；翻译/罗马音做行级清洗。
 * 无主歌词（只有翻译）、纯音乐占位、code != 200、请求失败均返回 null。
 */
export const getLyric = async(candidate: LX.Music.LyricsCandidate, signal?: AbortSignal): Promise<LX.Music.LyricResult | null> => {
  if (signal?.aborted) return null
  const startAt = Date.now()
  try {
    const json = await requestJson<NeteaseLyricResponse>(createLyricUrl(candidate.id), signal)
    const code = json.code ?? -1
    if (code !== 200) {
      log.warn(`media match source netease: get lyric code=${code}`)
      return null
    }
    if (json.nolyric === true || json.uncollected === true) {
      log.info(`media match source netease: lyric unavailable in ${Date.now() - startAt}ms`)
      return null
    }
    const result = validateLyricText(json.lrc?.lyric)
    // 无主歌词但只有翻译 → 视为无歌词
    if (!result) {
      log.info(`media match source netease: no valid lyric in ${Date.now() - startAt}ms`)
      return null
    }
    const tlyric = sanitizeExtendedLyric(json.tlyric?.lyric)
    const roma = sanitizeExtendedLyric(json.romalrc?.lyric)
    const rlyric = roma.length ? roma : sanitizeExtendedLyric(json.yromalrc?.lyric)
    log.info(`media match source netease: lyric fetched in ${Date.now() - startAt}ms`)
    return {
      ...result,
      tlyric,
      rlyric,
    }
  } catch (error: any) {
    if (signal?.aborted) return null
    log.warn(`media match source netease: get lyric failed: ${error?.message ?? error}`)
    return null
  }
}
