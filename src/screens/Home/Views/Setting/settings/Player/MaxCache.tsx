import { memo, useMemo } from 'react'
import { View } from 'react-native'

import InputItem, { type InputItemProps } from '../../components/InputItem'
import { createStyle, toast } from '@/utils/tools'
import { useSettingValue } from '@/store/setting/hook'
import { useI18n } from '@/lang'
import { updateSetting } from '@/core/common'

/**
 * 允许的最大缓存（单位：MiB，与界面标注一致）。
 *
 * 注意：原实现写成 `1024 * 1024 * 1024`，是**按字节**想的，但这里比较的
 * `parseInt(cacheSize)` 实际是 **MiB 数值**，于是这个上限永远不会命中，
 * 用户能填任意大值。按现在的换算链（settings MiB → `cacheSize * 1024`
 * → `MusicManager.java` 再 `* 1024`），填 2048 就是真 2 GiB 磁盘缓存。
 * 这里改成有意义的 MiB 上限，避免误填把手机存储塞满。
 */
const MAX_SIZE = 8192
export default memo(() => {
  const t = useI18n()
  const cacheSize = useSettingValue('player.cacheSize')
  const setCacheSize = (size: string) => {
    updateSetting({ 'player.cacheSize': size })
  }

  const size = useMemo(() => {
    let size: number | string = parseInt(cacheSize)
    if (size == 0 || Number.isNaN(size)) size = ''
    return size.toString()
  }, [cacheSize])

  const setSize: InputItemProps['onChanged'] = (value, callback) => {
    let size: number | string = parseInt(value)
    if (Number.isNaN(size) || size < 0) size = ''
    else if (size > MAX_SIZE) size = MAX_SIZE
    size = size.toString()
    callback(size)
    if (cacheSize == size) return
    setCacheSize(size)
    toast(t('setting_play_cache_size_save_tip'))
  }

  return (
    <View style={styles.content} >
      <InputItem
        value={size}
        label={t('setting_play_cache_size')}
        onChanged={setSize}
        keyboardType="number-pad"
        placeholder={t('setting_play_cache_size_no_cache')} />
    </View>
  )
})

const styles = createStyle({
  content: {
    marginTop: 10,
  },
})

