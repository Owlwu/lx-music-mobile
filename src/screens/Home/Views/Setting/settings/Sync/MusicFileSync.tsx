import { memo, useCallback, useRef } from 'react'
import { View } from 'react-native'

import Button from '../../components/Button'
import Text from '@/components/common/Text'
import { createStyle } from '@/utils/tools'
import { useI18n } from '@/lang'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import ChoosePath, { type ChoosePathType } from '@/components/common/ChoosePath'
import { useTheme } from '@/store/theme/hook'
import MusicFileScopeModal, { type MusicFileScopeModalType } from './MusicFileScopeModal'
import MusicFileSyncModal, { type MusicFileSyncModalType } from './MusicFileSyncModal'

export default memo(() => {
  const t = useI18n()
  const theme = useTheme()
  const root = useSettingValue('sync.musicFile.root')
  const scope = useSettingValue('sync.musicFile.scope')
  const choosePathRef = useRef<ChoosePathType>(null)
  const scopeModalRef = useRef<MusicFileScopeModalType>(null)
  const syncModalRef = useRef<MusicFileSyncModalType>(null)

  const handleSelectRoot = useCallback(() => {
    choosePathRef.current?.show({ title: t('setting_sync_music_file_root_btn'), dirOnly: true })
  }, [t])

  const handleConfirmRoot = useCallback((path: string) => {
    updateSetting({ 'sync.musicFile.root': path, 'sync.musicFile.scope': [] })
  }, [])

  const scopeSummary = !root
    ? t('setting_sync_music_file_scope_summary_empty')
    : scope.length
      ? t('setting_sync_music_file_scope_summary_part', { count: scope.length })
      : t('setting_sync_music_file_scope_summary_all')

  const handleOpenScope = useCallback(() => {
    scopeModalRef.current?.show()
  }, [])

  const handleOpenSync = useCallback(() => {
    syncModalRef.current?.show()
  }, [])

  return (
    <>
      <View style={styles.container}>
        <Text size={13} style={styles.label}>{t('setting_sync_music_file_root_label')}</Text>
        <Text size={13} style={styles.path} numberOfLines={2} color={root ? theme['c-font'] : theme['c-font-label']}>
          {root || t('setting_sync_music_file_root_empty')}
        </Text>
        <View style={styles.btnRow}>
          <Button onPress={handleSelectRoot}>{t('setting_sync_music_file_root_btn')}</Button>
          <Button disabled={!root} onPress={handleOpenScope}>{t('setting_sync_music_file_scope_btn')}</Button>
          <Button disabled={!root} onPress={handleOpenSync}>{t('setting_sync_music_file')}</Button>
        </View>
        <Text size={12} style={styles.summary} color={theme['c-font-label']}>{scopeSummary}</Text>
      </View>
      <ChoosePath ref={choosePathRef} onConfirm={handleConfirmRoot} />
      <MusicFileScopeModal ref={scopeModalRef} />
      <MusicFileSyncModal ref={syncModalRef} />
    </>
  )
})

const styles = createStyle({
  container: {
    marginTop: 5,
    paddingLeft: 25,
    paddingRight: 25,
    paddingBottom: 15,
  },
  label: {
    marginBottom: 4,
  },
  path: {
    marginBottom: 8,
  },
  btnRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  summary: {
    marginTop: 8,
  },
})
