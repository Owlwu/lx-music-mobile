import { useEffect, useState } from 'react'

import { View } from 'react-native'
import { useTheme } from '@/store/theme/hook'
import Text from '@/components/common/Text'
import Slider, { type SliderProps } from '@/components/common/Slider'
import ButtonPrimary from '@/components/common/ButtonPrimary'
import { useI18n } from '@/lang'
import { usePlayMusicInfo } from '@/store/player/hook'
import { getMusicVolume, saveMusicVolume } from '@/utils/data'
import { MUSIC_VOLUME_MAX, MUSIC_VOLUME_MIN, normalizeMusicInfo, setCurrentVolumeFactor } from '@/core/player/volume'
import styles from './style'

const MIN_VALUE = Math.trunc(MUSIC_VOLUME_MIN * 100)
const MAX_VALUE = Math.trunc(MUSIC_VOLUME_MAX * 100)
const DEFAULT_VALUE = 100

export default () => {
  const theme = useTheme()
  const t = useI18n()
  const playMusicInfo = usePlayMusicInfo()
  const musicInfo = playMusicInfo.musicInfo
  const [volume, setVolumeState] = useState(DEFAULT_VALUE)
  const [sliderSize, setSliderSize] = useState(DEFAULT_VALUE)
  const [isSliding, setSliding] = useState(false)

  useEffect(() => {
    if (!musicInfo) return
    let cancelled = false
    void getMusicVolume(normalizeMusicInfo(musicInfo)).then((factor) => {
      if (cancelled) return
      const value = Math.trunc(factor * 100)
      setVolumeState(value)
      setSliderSize(value)
    })
    return () => {
      cancelled = true
    }
  }, [musicInfo])

  if (!musicInfo) return null

  const handleSlidingStart: SliderProps['onSlidingStart'] = () => {
    setSliding(true)
  }
  const handleValueChange: SliderProps['onValueChange'] = value => {
    value = Math.trunc(value)
    setSliderSize(value)
    void setCurrentVolumeFactor(value / 100)
  }
  const handleSlidingComplete: SliderProps['onSlidingComplete'] = value => {
    setSliding(false)
    value = Math.trunc(value)
    setVolumeState(value)
    void saveMusicVolume(normalizeMusicInfo(musicInfo), value / 100)
  }
  const handleReset = () => {
    if (volume == DEFAULT_VALUE) return
    setVolumeState(DEFAULT_VALUE)
    setSliderSize(DEFAULT_VALUE)
    void setCurrentVolumeFactor(DEFAULT_VALUE / 100)
    void saveMusicVolume(normalizeMusicInfo(musicInfo), DEFAULT_VALUE / 100)
  }

  return (
    <View style={styles.container}>
      <Text>{t('play_detail_setting_music_volume')}</Text>
      <View style={styles.content}>
        <Text style={styles.label} color={theme['c-font-label']}>{`${isSliding ? sliderSize : volume}%`}</Text>
        <Slider
          minimumValue={MIN_VALUE}
          maximumValue={MAX_VALUE}
          onSlidingComplete={handleSlidingComplete}
          onValueChange={handleValueChange}
          onSlidingStart={handleSlidingStart}
          step={1}
          value={volume}
        />
      </View>
      <ButtonPrimary onPress={handleReset}>{t('play_detail_setting_music_volume_reset')}</ButtonPrimary>
    </View>
  )
}
