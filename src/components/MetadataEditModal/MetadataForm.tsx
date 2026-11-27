import { useImperativeHandle, forwardRef, useState, useCallback, useRef } from 'react'
import { View } from 'react-native'
import { createStyle } from '@/utils/tools'
import InputItem from './InputItem'
import { useI18n } from '@/lang'
import TextAreaItem from './TextAreaItem'
import PicItem from './PicItem'
import { useTheme } from '@/store/theme/hook'
import ParseName from './ParseName'
import { stat } from '@/utils/fs'
import { useUnmounted } from '@/utils/hooks'

export interface Metadata {
  name: string // 歌曲名
  singer: string // 艺术家名
  albumName: string // 歌曲专辑名称
  pic: string
  interval: string
}
export const defaultData = {
  name: '',
  singer: '',
  albumName: '',
  pic: '',
  interval: '',
}

export interface MetadataFormType {
  setForm: (path: string, metadata: Metadata) => void
  getForm: () => Metadata
}

export default forwardRef<MetadataFormType, {}>((props, ref) => {
  const t = useI18n()
  const [fileName, setFileName] = useState('')
  const filePath = useRef('')
  const [data, setData] = useState({ ...defaultData })
  const theme = useTheme()
  const isUnmounted = useUnmounted()

  useImperativeHandle(ref, () => ({
    setForm(path, data) {
      filePath.current = path
      // setPath(path)
      void stat(path).then(info => {
        if (isUnmounted.current) return
        setFileName(info.name)
      })
      setData(data)
    },
    getForm() {
      return {
        ...data,
        name: data.name.trim(),
        singer: data.singer.trim(),
        albumName: data.albumName.trim(),
      }
    },
  }))

  const handleUpdateName = useCallback((name: string) => {
    if (name.length > 150) name = name.substring(0, 150)
    setData(data => {
      return { ...data, name }
    })
  }, [])
  const handleUpdateSinger = useCallback((singer: string) => {
    if (singer.length > 150) singer = singer.substring(0, 150)
    setData(data => {
      return { ...data, singer }
    })
  }, [])
  const handleUpdateAlbumName = useCallback((albumName: string) => {
    if (albumName.length > 150) albumName = albumName.substring(0, 150)
    setData(data => {
      return { ...data, albumName }
    })
  }, [])
  const handleUpdatePic = useCallback((path: string) => {
    setData(data => {
      return { ...data, pic: path }
    })
  }, [])

  return (
    <View style={styles.container}>
      <TextAreaItem
        value={fileName}
        label={global.i18n.t('metadata_edit_modal_file_name')}
        numberOfLines={2}
        scrollEnabled
        editable={false}
        style={{ ...styles.pathText, color: theme['c-primary-font'] }}
      />

      <InputItem
        value={data.name}
        label={t('metadata_edit_modal_form_name')}
        onChanged={handleUpdateName}
        keyboardType="name-phone-pad" />
      <InputItem
        value={data.singer}
        label={t('metadata_edit_modal_form_singer')}
        onChanged={handleUpdateSinger}
        keyboardType="name-phone-pad" />
      <ParseName
        fileName={fileName}
        onNameChanged={handleUpdateName}
        onSingerChanged={handleUpdateSinger}
      />
      <InputItem
        value={data.albumName}
        label={t('metadata_edit_modal_form_album_name')}
        onChanged={handleUpdateAlbumName}
        keyboardType="name-phone-pad" />

      <PicItem
        value={data.pic}
        label={t('metadata_edit_modal_form_pic')}
        onChanged={handleUpdatePic} />
    </View>
  )
})

const styles = createStyle({
  container: {
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: 'column',
  },
  pathText: {
    height: 60,
  },
})


