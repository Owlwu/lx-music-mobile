import { memo } from 'react'
import { Pressable, View } from 'react-native'

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

// 缩略图固定 64dp（介于契约要求的 56–72 之间），不走 createStyle 的尺寸缩放
const thumbStyle = { width: 64, height: 64, borderRadius: 4 }

export default memo(({ candidate, selected, onPress }: CandidateItemProps) => {
  const theme = useTheme()
  const t = useI18n()

  const sourceLabel = candidate.source === 'qq' ? t('cover_match_source_qq') : t('cover_match_source_itunes')
  const durationText = candidate.durationSec == null ? '' : formatPlayTime2(candidate.durationSec)
  const scoreText = `${Math.round(candidate.score * 100)}%`

  return (
    <Pressable
      style={{
        ...styles.container,
        backgroundColor: selected ? theme['c-primary-background-active'] : theme['c-primary-input-background'],
      }}
      onPress={() => { onPress(candidate) }}
    >
      <Image url={candidate.thumbnailUrl} style={thumbStyle} resizeMode="cover" />
      <View style={styles.main}>
        <Text size={14} numberOfLines={1}>{candidate.name || '-'}</Text>
        <Text size={12} style={styles.meta} color={theme['c-font-label']} numberOfLines={1}>
          {[candidate.singer, candidate.albumName, durationText].filter(Boolean).join(' · ') || '-'}
        </Text>
        <View style={styles.tags}>
          <Text size={11} color={theme['c-font-label']}>{sourceLabel}</Text>
          <Text size={11} color={theme['c-font-label']}>{scoreText}</Text>
        </View>
      </View>
    </Pressable>
  )
})

const styles = createStyle({
  container: {
    flexGrow: 0,
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
    paddingLeft: 10,
    paddingRight: 10,
    paddingTop: 8,
    paddingBottom: 8,
    borderRadius: 6,
  },
  main: {
    flexGrow: 1,
    flexShrink: 1,
    marginLeft: 10,
  },
  meta: {
    marginTop: 3,
  },
  tags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 5,
    gap: 12,
  },
})
