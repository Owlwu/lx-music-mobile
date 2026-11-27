import { memo } from 'react'

import { StyleSheet, View } from 'react-native'
import Text from '@/components/common/Text'
import MediaAction from '@/components/MediaEdit/Action'
import { useI18n } from '@/lang'


export interface ParseNameProps {
  fileName: string
  onNameChanged: (text: string) => void
  onSingerChanged: (text: string) => void
}

const parsePath = (fileName: string) => {
  return fileName.substring(0, fileName.lastIndexOf('.')).split('-').map(name => name.trim())
}

export default memo(({ fileName, onNameChanged, onSingerChanged }: ParseNameProps) => {
  const t = useI18n()
  const handleParseNameSinger = () => {
    const [name, singer] = parsePath(fileName)
    onNameChanged(name)
    if (singer) onSingerChanged(singer)
  }
  const handleParseSingerName = () => {
    const [singer, name] = parsePath(fileName)
    onSingerChanged(singer)
    if (name) onNameChanged(name)
  }
  return (
    <View style={styles.container}>
      <Text style={styles.label} size={14}>{t('metadata_edit_modal_form_parse_name')}</Text>
      <View style={styles.btns}>
        <MediaAction disabled={!fileName} onPress={handleParseNameSinger}>{t('metadata_edit_modal_form_parse_name_singer')}</MediaAction>
        <MediaAction disabled={!fileName} onPress={handleParseSingerName}>{t('metadata_edit_modal_form_parse_singer_name')}</MediaAction>
      </View>
    </View>
  )
})

const styles = StyleSheet.create({
  container: {
    // paddingLeft: 25,
    marginBottom: 15,
  },
  label: {
    marginBottom: 2,
  },
  btns: {
    marginTop: 5,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
})
