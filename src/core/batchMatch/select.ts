const MIN_AUTOMATIC_MATCH_SCORE = 0.90
const MAX_LYRIC_ATTEMPTS = 5
const MAX_COVER_ATTEMPTS = 3

interface ScoredCandidate {
  score: number
  instrumental?: boolean
}

const getAttemptIndexes = (candidates: readonly ScoredCandidate[], limit: number): number[] => {
  const indexes: number[] = []
  for (let index = 0; index < candidates.length && indexes.length < limit; index++) {
    const candidate = candidates[index]
    if (candidate.instrumental === true || !Number.isFinite(candidate.score) || candidate.score < MIN_AUTOMATIC_MATCH_SCORE) continue
    indexes.push(index)
  }
  return indexes
}

export const getLyricAttemptIndexes = (candidates: readonly ScoredCandidate[]) => getAttemptIndexes(candidates, MAX_LYRIC_ATTEMPTS)
export const getCoverAttemptIndexes = (candidates: readonly ScoredCandidate[]) => getAttemptIndexes(candidates, MAX_COVER_ATTEMPTS)
