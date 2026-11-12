// 在线歌词匹配的候选打分与排序（纯函数，无平台依赖）
import { bigramDice, normalizeText } from './normalize'
import { hasInstrumentalMarker } from './query'

const artistSplitRxp = /\s*(?:\/|、|,|;|&|feat\.?|ft\.?|featuring|with)\s*/i

const compareText = (a?: string | null, b?: string | null): number => {
  const na = normalizeText(a)
  const nb = normalizeText(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  if (na.includes(nb) || nb.includes(na)) return 0.85
  return bigramDice(na, nb) * 0.8
}

const splitArtists = (singer?: string | null): string[] => {
  if (!singer) return []
  return singer.split(artistSplitRxp).map(item => item.trim()).filter(Boolean)
}

/**
 * 标题得分：完全相同 1.0 / 包含 0.85 / bigram Dice * 0.8
 */
export const scoreTitle = (queryName: string, candidateName: string): number => {
  return compareText(queryName, candidateName)
}

/**
 * 歌手得分：候选中的任意歌手与查询歌手逐一比较取最大值；歌手为空时给 0.5（中性）
 */
export const scoreArtist = (querySinger?: string | null, candidateSinger?: string | null): number => {
  if (!querySinger?.trim() || !candidateSinger?.trim()) return 0.5
  const queryArtists = splitArtists(querySinger)
  const candidateArtists = splitArtists(candidateSinger)
  if (!queryArtists.length || !candidateArtists.length) return 0.5

  let best = compareText(querySinger, candidateSinger)
  for (const queryArtist of queryArtists) {
    for (const candidateArtist of candidateArtists) {
      best = Math.max(best, compareText(queryArtist, candidateArtist))
    }
  }
  return best
}

/**
 * 时长得分：双方都有时长时 |diff|<=2s→1.0, <=5s→0.8, <=10s→0.5, else 0.1；缺一方→0.5
 */
export const scoreDuration = (queryDurationSec: number | null, candidateDurationSec: number | null): number => {
  if (queryDurationSec == null || candidateDurationSec == null) return 0.5
  const diff = Math.abs(queryDurationSec - candidateDurationSec)
  if (diff <= 2) return 1
  if (diff <= 5) return 0.8
  if (diff <= 10) return 0.5
  return 0.1
}

/**
 * 综合得分：score = 0.5*titleScore + 0.3*artistScore + 0.2*durationScore
 * 候选标题带伴奏/纯音乐标记而查询本身不带时，作为强负信号 score *= 0.5
 */
export const scoreCandidate = (query: LX.Music.MatchQuery, candidate: Pick<LX.Music.LyricsCandidate, 'name' | 'singer' | 'durationSec'>): number => {
  const titleScore = scoreTitle(query.name, candidate.name)
  const artistScore = scoreArtist(query.singer, candidate.singer)
  const durationScore = scoreDuration(query.durationSec, candidate.durationSec)
  let score = 0.5 * titleScore + 0.3 * artistScore + 0.2 * durationScore
  const queryHasMarker = hasInstrumentalMarker(query.name) || hasInstrumentalMarker(query.fileStem)
  if (!queryHasMarker && hasInstrumentalMarker(candidate.name)) score *= 0.5
  return score
}

const createDedupeKey = (candidate: LX.Music.LyricsCandidate): string => {
  const duration = candidate.durationSec == null ? '' : Math.round(candidate.durationSec)
  return `${normalizeText(candidate.name)}|${normalizeText(candidate.singer)}|${duration}`
}

/**
 * 合并去重：normalize(name)|normalize(singer)|round(duration) 相同视为重复，保留分数高者
 */
export const dedupeCandidates = (candidates: LX.Music.LyricsCandidate[]): LX.Music.LyricsCandidate[] => {
  const result = new Map<string, LX.Music.LyricsCandidate>()
  for (const candidate of candidates) {
    const key = createDedupeKey(candidate)
    const existed = result.get(key)
    if (!existed || candidate.score > existed.score) result.set(key, candidate)
  }
  return Array.from(result.values())
}

/**
 * 打分 -> 去重 -> 按分数降序 -> 截断
 */
export const rankCandidates = (query: LX.Music.MatchQuery, candidates: LX.Music.LyricsCandidate[], limit = 30): LX.Music.LyricsCandidate[] => {
  const scored = candidates.map(candidate => ({ ...candidate, score: scoreCandidate(query, candidate) }))
  return dedupeCandidates(scored)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}
