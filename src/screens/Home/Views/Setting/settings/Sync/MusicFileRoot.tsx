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

/**
 * 本地音乐文件同步 —— 手机端只需设置「同步歌曲存放路径」
 *
 * 同步一律由 PC 端界面发起，手机端只是被同步的一方：
 * PC 会通过 `musicFile_get_root` / `musicFile_get_index(scope)` / `musicFile_write_file` 等
 * RPC 驱动手机端读写。因此手机端**不需要**：
 *
 * - 「本地音乐文件同步」按钮：那是「由手机发起同步」的入口（compare/apply），实际使用中
 *   不会用到，留着只会让用户误以为同步要在手机上点；
 * - 「选择同步文件夹」按钮：参与同步的文件夹由 PC 发起时的勾选决定，PC 会把自己的
 *   scope 一起传过来（见 desktop `service.ts` 的 `peer.musicFile_get_index(scope)`），
 *   手机端自己的 scope 设置对 PC 发起的同步没有任何影响，留着反而会误导。
 *
 * 需要保留的只有存放路径：PC 端读写的相对路径都要落到这个目录下。
 */
export default memo(() => {
  const t = useI18n()
  const theme = useTheme()
  const root = useSettingValue('sync.musicFile.root')
  const choosePathRef = useRef<ChoosePathType>(null)

  const handleSelectRoot = useCallback(() => {
    choosePathRef.current?.show({ title: t('setting_sync_music_file_root_btn'), dirOnly: true })
  }, [t])

  const handleConfirmRoot = useCallback((path: string) => {
    updateSetting({ 'sync.musicFile.root': path })
  }, [])

  return (
    <>
      <View style={styles.container}>
        <Text size={13} style={styles.title}>{t('setting_sync_music_file')}</Text>
        <Text size={13} style={styles.label}>{t('setting_sync_music_file_root_label')}</Text>
        <Text size={13} style={styles.path} numberOfLines={2} color={root ? theme['c-font'] : theme['c-font-label']}>
          {root || t('setting_sync_music_file_root_empty')}
        </Text>
        <View style={styles.btnRow}>
          <Button onPress={handleSelectRoot}>{t('setting_sync_music_file_root_btn')}</Button>
        </View>
        <Text size={12} style={styles.summary} color={theme['c-font-label']}>{t('setting_sync_music_file_root_tip')}</Text>
      </View>
      <ChoosePath ref={choosePathRef} onConfirm={handleConfirmRoot} />
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
  title: {
    marginBottom: 8,
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
