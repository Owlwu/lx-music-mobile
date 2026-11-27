import { memo } from 'react'
import { View } from 'react-native'

import MediaCandidate from '@/components/MediaEdit/Candidate'
import Text from '@/components/common/Text'
import Image from '@/components/common/Image'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { createStyle } from '@/utils/tools'
import { formatPlayTime2 } from '@/utils/common'

export interface CandidateItemProps {
  candidate: LX.Music.CoverCandidate
  selected: boolean
  onPress: (candidate: LX.Music.CoverCandidate) => void
}

const thumbStyle = { width: 56, height: 56, borderRadius: 4 }

export default memo(({ candidate, selected, onPress }: CandidateItemProps) => {
  const theme = useTheme()
  const t = useI18n()

  const sourceLabel = candidate.source === 'qq' ? t('cover_match_source_qq') : t('cover_match_source_itunes')
  const durationText = candidate.durationSec == null ? '' : formatPlayTime2(candidate.durationSec)
  const scoreText = t('cover_match_song_score', { score: Math.round(candidate.score * 100) })
  const details = [candidate.singer, candidate.albumName, durationText].filter(Boolean).join(' · ')
  const label = [candidate.name, details, sourceLabel, scoreText].filter(Boolean).join(', ')

  return (
    <MediaCandidate label={label} selected={selected} onPress={() => { onPress(candidate) }}
      leading={<Image url={candidate.thumbnailUrl} style={thumbStyle} resizeMode="cover" />}>
      <View style={styles.main}>
        <Text size={14} numberOfLines={1}>{candidate.name || '-'}</Text>
        <Text size={12} style={styles.meta} color={theme['c-font-label']} numberOfLines={1}>
          {details || '-'}
        </Text>
        <View style={styles.tags}>
          <Text size={11} color={theme['c-font-label']}>{sourceLabel}</Text>
          <Text size={11} color={theme['c-font-label']}>{scoreText}</Text>
        </View>
      </View>
    </MediaCandidate>
  )
})

const styles = createStyle({
  main: {
    flexGrow: 1,
    flexShrink: 1,
  },
  meta: {
    marginTop: 1,
  },
  tags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 2,
    gap: 12,
  },
})
