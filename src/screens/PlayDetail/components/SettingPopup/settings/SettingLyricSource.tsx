import { useEffect, useMemo, useState } from 'react'
import { View } from 'react-native'

import Text from '@/components/common/Text'
import CheckBox from '@/components/common/CheckBox'
import ButtonPrimary from '@/components/common/ButtonPrimary'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { usePlayMusicInfo } from '@/store/player/hook'
import { useSettingValue } from '@/store/setting/hook'
import { getLyricInfo } from '@/core/music/local'
import { rollbackLrc, updateMusicLyricSource } from '@/core/mediaMatch'
import { getLrcState, type LrcState } from '@/utils/lrcFile'
import { confirmDialog, toast } from '@/utils/tools'
import { log } from '@/utils/log'
import styles from './style'

const SOURCE_LIST = ['embedded', 'lrc'] as const

export default () => {
  const t = useI18n()
  const theme = useTheme()
  const playMusicInfo = usePlayMusicInfo()
  const defaultSource = useSettingValue('player.lyricSource')
  const [lrcState, setLrcState] = useState<LrcState | null>(null)
  const [actualSource, setActualSource] = useState<LX.Music.LyricSource | null>(null)
  const [hasEditedLyric, setHasEditedLyric] = useState(false)
  const [processing, setProcessing] = useState(false)

  const musicInfo = playMusicInfo.musicInfo

  const getSourceLabel = (source: LX.Music.LyricSource | null | undefined): string => {
    switch (source) {
      case 'embedded':
        return t('lyrics_match_source_embedded')
      case 'lrc':
        return t('lyrics_match_source_lrc')
      default:
        return t('lyrics_match_source_none')
    }
  }

  useEffect(() => {
    let canceled = false
    if (!musicInfo) {
      setLrcState(null)
      setActualSource(null)
      setHasEditedLyric(false)
      return
    }
    void getLrcState(musicInfo.meta.filePath).then(state => {
      if (canceled) return
      setLrcState(state)
    }).catch((error: any) => {
      log.warn(`get lrc state failed: ${error?.message ?? error}`)
    })
    void getLyricInfo({ musicInfo, isRefresh: false }).then(info => {
      if (canceled) return
      setActualSource(info.source ?? null)
      setHasEditedLyric(!!info.lyric?.trim() && info.source == null)
    }).catch((error: any) => {
      log.warn(`get lyric info failed: ${error?.message ?? error}`)
    })
    return () => {
      canceled = true
    }
  }, [musicInfo])

  const preferredSource = musicInfo?.meta.lyricSource ?? defaultSource ?? 'embedded'
  const actualSourceLabel = useMemo(() => {
    if (actualSource) return getSourceLabel(actualSource)
    return hasEditedLyric ? t('lyrics_match_source_edited') : getSourceLabel(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actualSource, hasEditedLyric, t])

  const handleChangeSource = async(source: LX.Music.LyricSource) => {
    if (!musicInfo || processing) return
    if (preferredSource === source) return
    setProcessing(true)
    try {
      const updatedMusicInfo = await updateMusicLyricSource({
        listId: playMusicInfo.listId,
        musicInfo,
        source,
      })
      const info = await getLyricInfo({ musicInfo: updatedMusicInfo, isRefresh: false })
      if (info.source !== source) {
        toast(t('lyrics_match_source_fallback', { source: info.source ? getSourceLabel(info.source) : getSourceLabel(null) }), 'long')
      }
    } catch (error: any) {
      log.warn(`change lyric source failed: ${error?.message ?? error}`)
      toast(t('lyrics_match_error_other', { message: error?.message ?? String(error) }), 'long')
    } finally {
      setProcessing(false)
    }
  }

  const handleRollback = async() => {
    if (!musicInfo || processing) return
    if (!lrcState?.backupExists) {
      toast(t('lyrics_match_rollback_unavailable'))
      return
    }
    const confirmed = await confirmDialog({
      message: t('lyrics_match_rollback_confirm'),
      confirmButtonText: t('lyrics_match_rollback'),
    })
    if (!confirmed) return

    setProcessing(true)
    try {
      const result = await rollbackLrc({ listId: playMusicInfo.listId, musicInfo })
      if (!result.restored) {
        toast(t('lyrics_match_rollback_unavailable'))
        return
      }
      toast(t('lyrics_match_rollback_success'))
      setLrcState(await getLrcState(musicInfo.meta.filePath))
    } catch (error: any) {
      log.warn(`rollback lrc failed: ${error?.message ?? error}`)
      const code = error instanceof Error && 'code' in error ? String(error.code) : ''
      const message = code === 'permission'
        ? t('lyrics_match_error_permission')
        : code === 'no_space'
          ? t('lyrics_match_error_no_space')
          : error?.message ?? String(error)
      toast(t('lyrics_match_rollback_failed', { message }), 'long')
    } finally {
      setProcessing(false)
    }
  }

  if (!musicInfo) return null

  return (
    <View style={styles.container}>
      <Text>{t('lyrics_match_source_title')}</Text>
      <View style={styles.content}>
        {
          SOURCE_LIST.map(source => (
            <CheckBox
              key={source}
              marginBottom={3}
              check={preferredSource === source}
              label={getSourceLabel(source)}
              disabled={processing}
              need
              onChange={() => { void handleChangeSource(source) }}
            />
          ))
        }
      </View>
      <Text size={12} color={theme['c-font-label']}>
        {t('lyrics_match_source_current', { source: actualSourceLabel })}
      </Text>
      <Text size={12} color={theme['c-font-label']}>
        {t('lyrics_match_source_default_hint', { source: getSourceLabel(defaultSource) })}
      </Text>
      {preferredSource === 'lrc' && lrcState && !lrcState.lrcExists
        ? <Text size={12} color={theme['c-primary-font']}>{t('lyrics_match_source_lrc_missing')}</Text>
        : null}
      <ButtonPrimary disabled={!lrcState?.backupExists || processing} onPress={() => { void handleRollback() }}>
        {t('lyrics_match_rollback')}
      </ButtonPrimary>
      {lrcState && !lrcState.backupExists
        ? <Text size={12} color={theme['c-font-label']}>{t('lyrics_match_rollback_unavailable')}</Text>
        : null}
    </View>
  )
}
