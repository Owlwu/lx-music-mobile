import { updateSetting } from '@/core/common'
import { useI18n } from '@/lang'
import { createStyle } from '@/utils/tools'
import { memo } from 'react'
import { View } from 'react-native'
import { useSettingValue } from '@/store/setting/hook'


import CheckBoxItem from '../../components/CheckBoxItem'

export default memo(() => {
  const t = useI18n()
  const isDeleteLocalFileWhenRemove = useSettingValue('list.isDeleteLocalFileWhenRemove')
  const setDeleteLocalFileWhenRemove = (isDeleteLocalFileWhenRemove: boolean) => {
    requestAnimationFrame(() => {
      updateSetting({ 'list.isDeleteLocalFileWhenRemove': isDeleteLocalFileWhenRemove })
    })
  }

  return (
    <View style={styles.content}>
      <CheckBoxItem check={isDeleteLocalFileWhenRemove} onChange={setDeleteLocalFileWhenRemove} label={t('setting_list_delete_local_file_when_remove')} />
    </View>
  )
})


const styles = createStyle({
  content: {
    marginTop: 5,
  },
})
