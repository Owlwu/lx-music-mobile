import { memo } from 'react'
import { Pressable, View } from 'react-native'
import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { createStyle } from '@/utils/tools'
import { formatPlayTime2 } from '@/utils/common'

export interface CandidateItemProps {
  candidate: LX.Music.LyricsCandidate
  selected: boolean
  onPress: (candidate: LX.Music.LyricsCandidate) => void
}

export default memo(({ candidate, selected, onPress }: CandidateItemProps) => {
  const theme = useTheme()
  const t = useI18n()

  const sourceLabel = candidate.source === 'qq' ? t('lyrics_match_source_qq') : t('lyrics_match_source_lrclib')
  const durationText = candidate.durationSec == null ? '' : formatPlayTime2(candidate.durationSec)

  return (
    <Pressable
      style={{
        ...styles.container,
        backgroundColor: selected ? theme['c-primary-background-active'] : theme['c-primary-input-background'],
      }}
      onPress={() => { onPress(candidate) }}
    >
      <View style={styles.main}>
        <Text size={14} numberOfLines={1}>{candidate.name || '-'}</Text>
        <Text size={12} style={styles.meta} color={theme['c-font-label']} numberOfLines={1}>
          {[candidate.singer, candidate.albumName, durationText].filter(Boolean).join(' · ') || '-'}
        </Text>
        <View style={styles.tags}>
          <Text size={11} color={theme['c-font-label']}>{sourceLabel}</Text>
          <Text size={11} color={theme['c-font-label']}>{candidate.hasSynced == null ? t('lyrics_match_synced_unknown') : candidate.hasSynced ? t('lyrics_match_has_synced') : t('lyrics_match_no_synced')}</Text>
          {candidate.instrumental ? <Text size={11} color={theme['c-primary-font']}>{t('lyrics_match_instrumental')}</Text> : null}
        </View>
      </View>
    </Pressable>
  )
})

const styles = createStyle({
  container: {
    flexGrow: 0,
    flexShrink: 0,
    marginBottom: 6,
    paddingLeft: 12,
    paddingRight: 12,
    paddingTop: 8,
    paddingBottom: 8,
    borderRadius: 6,
  },
  main: {
    flexGrow: 1,
    flexShrink: 1,
  },
  meta: {
    marginTop: 3,
  },
  tags: {
    flexDirection: 'row',
    marginTop: 5,
    gap: 12,
  },
})
