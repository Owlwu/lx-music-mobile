import { memo } from 'react'
import { View } from 'react-native'
import MediaCandidate from '@/components/MediaEdit/Candidate'
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

  const sourceLabel = candidate.source === 'qq'
    ? t('lyrics_match_source_qq')
    : candidate.source === 'netease'
      ? t('lyrics_match_source_netease')
      : t('lyrics_match_source_lrclib')
  const durationText = candidate.durationSec == null ? '' : formatPlayTime2(candidate.durationSec)
  const details = [candidate.singer, candidate.albumName].filter(Boolean).join(' · ')
  const syncLabel = t(candidate.hasSynced == null ? 'lyrics_match_synced_unknown' : candidate.hasSynced ? 'lyrics_match_has_synced' : 'lyrics_match_no_synced')
  const instrumentalLabel = candidate.instrumental ? t('lyrics_match_instrumental') : ''
  const label = [candidate.name, details, durationText, sourceLabel, syncLabel, instrumentalLabel].filter(Boolean).join(', ')

  return (
    <MediaCandidate label={label} selected={selected} onPress={() => { onPress(candidate) }}>
      <View style={styles.main}>
        <Text size={14} numberOfLines={1}>{candidate.name || '-'}</Text>
        <View style={styles.metaRow}>
          <Text size={12} style={styles.metaText} color={theme['c-700']} numberOfLines={1}>
            {details || '-'}
          </Text>
          {durationText
            ? <Text size={12} style={styles.metaDuration} color={theme['c-700']}>{durationText}</Text>
            : null}
        </View>
        <View style={styles.tags}>
          <Text size={11} color={theme['c-700']}>{sourceLabel}</Text>
          <Text size={11} color={theme['c-700']}>{syncLabel}</Text>
          {instrumentalLabel ? <Text size={11} color={theme['c-700']}>{instrumentalLabel}</Text> : null}
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
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 1,
  },
  // 歌手/专辑过长时只压缩这一侧，时长始终完整显示
  metaText: {
    flexGrow: 1,
    flexShrink: 1,
  },
  metaDuration: {
    flexGrow: 0,
    flexShrink: 0,
    marginLeft: 8,
  },
  tags: {
    flexDirection: 'row',
    marginTop: 2,
    gap: 12,
  },
})
