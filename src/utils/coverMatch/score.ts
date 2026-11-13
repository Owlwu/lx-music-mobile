// 封面候选评分（纯函数，无平台依赖，可单测）
//
// 与桌面 `src/common/utils/coverMatch/score.ts` 行为一致：
// 复用一期权重 0.5 * 标题 + 0.3 * 歌手 + 0.2 * 时长；
// 封面额外增加专辑加分：本地专辑与候选专辑归一化后相同/包含 +0.05，总分封顶 1。
// 伴奏/纯音乐标记沿用一期惩罚：候选标题带标记且查询本身不带时 score *= 0.5。
// 归一化与伴奏标记复用一期 `@/utils/mediaMatch` 的实现。
import { bigramDice, normalizeText } from '@/utils/mediaMatch/normalize'
import { hasInstrumentalMarker } from '@/utils/mediaMatch/query'

const splitSingers = (singer: string): string[] => {
  return (singer ?? '')
    .split(/[、,，/&;；]+/)
    .map(s => s.trim())
    .filter(Boolean)
}

const nameSimilarity = (a: string, b: string): number => {
  const left = normalizeText(a)
  const right = normalizeText(b)
  if (!left || !right) return 0
  if (left === right) return 1
  if (left.includes(right) || right.includes(left)) return 0.85
  return bigramDice(left, right) * 0.8
}

export const titleScore = (queryName: string, candidateName: string): number => {
  return nameSimilarity(queryName, candidateName)
}

export const artistScore = (querySinger: string, candidateSinger: string): number => {
  const querySingers = splitSingers(querySinger)
  const candidateSingers = splitSingers(candidateSinger)
  // 歌手为空时给中性分
  if (!querySingers.length || !candidateSingers.length) return 0.5
  let max = 0
  for (const query of querySingers) {
    for (const candidate of candidateSingers) {
      max = Math.max(max, nameSimilarity(query, candidate))
    }
  }
  return max
}

export const durationScore = (queryDurationSec: number | null, candidateDurationSec: number | null): number => {
  if (queryDurationSec == null || candidateDurationSec == null) return 0.5
  const diff = Math.abs(queryDurationSec - candidateDurationSec)
  // 秒级容差：±2s 视为一致
  if (diff <= 2) return 1
  if (diff <= 5) return 0.8
  if (diff <= 10) return 0.5
  return 0.1
}

/**
 * 专辑加分：归一化后完全相同或互相包含时 +0.05，否则 0
 */
export const albumBonus = (queryAlbumName: string, candidateAlbumName: string): number => {
  const left = normalizeText(queryAlbumName)
  const right = normalizeText(candidateAlbumName)
  if (!left || !right) return 0
  return left === right || left.includes(right) || right.includes(left) ? 0.05 : 0
}

/**
 * 查询本身是否疑似伴奏/纯音乐
 */
export const isInstrumentalQuery = (query: LX.Music.MatchQuery): boolean => {
  return hasInstrumentalMarker(query.name) || hasInstrumentalMarker(query.fileStem)
}

/**
 * 0..1 候选综合评分（4 位小数）
 */
export const scoreCoverCandidate = (
  query: LX.Music.MatchQuery,
  candidate: LX.Music.CoverCandidate,
): number => {
  let score = 0.5 * titleScore(query.name, candidate.name) +
    0.3 * artistScore(query.singer, candidate.singer) +
    0.2 * durationScore(query.durationSec, candidate.durationSec) +
    albumBonus(query.albumName, candidate.albumName)

  score = Math.min(score, 1)

  // 候选标题里的伴奏/纯音乐标记是强负信号；查询本身已带标记时不扣分
  if (!isInstrumentalQuery(query) && hasInstrumentalMarker(candidate.name)) score *= 0.5

  return Math.round(Math.min(Math.max(score, 0), 1) * 10000) / 10000
}

/**
 * 专辑维度去重键：同一专辑只保留分数最高者
 */
export const getCoverDedupeKey = (candidate: LX.Music.CoverCandidate): string => {
  return `${candidate.source}:${candidate.id}`
}

export const mergeCoverCandidates = (
  candidates: LX.Music.CoverCandidate[],
): LX.Music.CoverCandidate[] => {
  const map = new Map<string, LX.Music.CoverCandidate>()
  for (const candidate of candidates) {
    const key = getCoverDedupeKey(candidate)
    const prev = map.get(key)
    if (!prev || candidate.score > prev.score) map.set(key, candidate)
  }
  return [...map.values()]
}

/**
 * 打分、专辑维度去重、按分数降序并截断
 */
export const rankCoverCandidates = (
  query: LX.Music.MatchQuery,
  candidates: LX.Music.CoverCandidate[],
  limit = 20,
): LX.Music.CoverCandidate[] => {
  const scored = candidates.map(candidate => ({
    ...candidate,
    score: scoreCoverCandidate(query, candidate),
  }))
  return mergeCoverCandidates(scored)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}
