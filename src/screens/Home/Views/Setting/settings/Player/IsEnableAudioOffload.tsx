import { updateSetting } from '@/core/common'
import { useI18n } from '@/lang'
import { createStyle, toast } from '@/utils/tools'
import { memo } from 'react'
import { View } from 'react-native'
import { useSettingValue } from '@/store/setting/hook'


import CheckBoxItem from '../../components/CheckBoxItem'

export default memo(() => {
  const t = useI18n()
  const isEnableAudioOffload = useSettingValue('player.isEnableAudioOffload')
  const setEnableAudioOffload = (value: boolean) => {
    updateSetting({ 'player.isEnableAudioOffload': value })
    toast(t('setting_play_audio_offload_restart_tip'))
  }

  return (
    <View style={styles.content}>
      <CheckBoxItem
        check={isEnableAudioOffload}
        onChange={setEnableAudioOffload}
        helpDesc={t('setting_play_audio_offload_tip')}
        label={t('setting_play_audio_offload')}
      />
    </View>
  )
})


const styles = createStyle({
  content: {
    marginTop: 5,
  },
})

