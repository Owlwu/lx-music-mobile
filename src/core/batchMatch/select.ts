/**
 * 一键补全的「自动选择」纯规则（契约 §5，与桌面端一致）：
 *
 * - 歌词：`[0, ...(1..4 中 !instrumental && score >= 0.6 的下标)]`，
 *   即先试排序第 1 个，失败后沿排序最多再试 4 个「分数够高且不是纯音乐」的候选；
 * - 封面：`[0, 1, 2]`，即第 1 个失败后最多再试后续 2 个。
 *
 * 候选数组由 `rankCandidates` / `rankCoverCandidates` 按 score 降序排好，
 * 这里只返回尝试顺序的下标，取词/下载失败的重试由调用方循环处理。
 */

export const LYRIC_FALLBACK_MIN_SCORE = 0.6
export const MAX_LYRIC_FALLBACK_ATTEMPTS = 4
export const MAX_COVER_ATTEMPTS = 3

export interface LyricAttemptCandidate {
  score: number
  instrumental?: boolean
}

/**
 * 歌词尝试下标：候选 0 无论分数/纯音乐标记都会先试一次（契约 §5 原文），
 * 之后的 1..4 只保留 `!instrumental && score >= 0.6`。
 */
export const getLyricAttemptIndexes = (candidates: readonly LyricAttemptCandidate[]): number[] => {
  if (!candidates.length) return []
  const indexes: number[] = [0]
  const lastIndex = Math.min(candidates.length - 1, MAX_LYRIC_FALLBACK_ATTEMPTS)
  for (let index = 1; index <= lastIndex; index++) {
    const candidate = candidates[index]
    if (candidate.instrumental) continue
    if (candidate.score < LYRIC_FALLBACK_MIN_SCORE) continue
    indexes.push(index)
  }
  return indexes
}

/**
 * 封面尝试下标：按排序取前 3 个（第 1 个 + 最多 2 个回退）
 */
export const getCoverAttemptIndexes = (candidates: readonly unknown[]): number[] => {
  return candidates.slice(0, MAX_COVER_ATTEMPTS).map((_, index) => index)
}
