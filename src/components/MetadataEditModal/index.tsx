import { useRef, useImperativeHandle, forwardRef, useState } from 'react'
import Dialog, { type DialogType } from '@/components/common/Dialog'
import MediaAction from '@/components/MediaEdit/Action'
import { mediaEditStyles } from '@/components/MediaEdit/styles'
import { ScrollView, View } from 'react-native'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { TEMP_FILE_PATH, toast } from '@/utils/tools'
import {
  readMetadata,
  readPic,
  writeMetadata,
  writePic,
} from '@/utils/localMediaMetadata'
import { useUnmounted } from '@/utils/hooks'
import MetadataForm, { defaultData, type Metadata, type MetadataFormType } from './MetadataForm'
import { log } from '@/utils/log'
import { formatPlayTime2 } from '@/utils'
import { unlink } from '@/utils/fs'

export type {
  Metadata,
}

export interface MetadataEditType {
  show: (filePath: string) => void
}
export interface MetadataEditProps {
  onUpdate: (info: Metadata) => void
}


export default forwardRef<MetadataEditType, MetadataEditProps>((props, ref) => {
  const dialogRef = useRef<DialogType>(null)
  const t = useI18n()
  const theme = useTheme()
  const metadataFormRef = useRef<MetadataFormType>(null)
  const filePath = useRef<string>('')
  const metadata = useRef<Metadata>({ ...defaultData })
  const [visible, setVisible] = useState(false)
  const [processing, setProcessing] = useState(false)
  const isUnmounted = useUnmounted()

  const handleShow = (filePath: string) => {
    dialogRef.current?.setVisible(true)
    void Promise.all([
      readMetadata(filePath),
      readPic(filePath).catch(() => ''),
    ]).then(async([_metadata, pic]) => {
      if (!_metadata) return
      if (isUnmounted.current) return
      metadata.current = {
        name: _metadata.name,
        singer: _metadata.singer,
        albumName: _metadata.albumName,
        pic,
        interval: formatPlayTime2(_metadata.interval),
      }
      requestAnimationFrame(() => {
        metadataFormRef.current?.setForm(filePath, metadata.current)
      })
    })
  }
  useImperativeHandle(ref, () => ({
    show(path) {
      filePath.current = path
      if (visible) handleShow(path)
      else {
        setVisible(true)
        requestAnimationFrame(() => {
          handleShow(path)
        })
      }
    },
  }))

  const handleUpdate = async() => {
    if (!metadataFormRef.current) return
    let _metadata = metadataFormRef.current.getForm()
    if (!_metadata.name) {
      toast(global.i18n.t('metadata_edit_modal_tip'), 'long')
      return
    }
    setProcessing(true)
    let isUpdated = false
    try {
      if (
        _metadata.name != metadata.current.name ||
        _metadata.singer != metadata.current.singer ||
        _metadata.albumName != metadata.current.albumName
      ) {
        isUpdated ||= true
        await writeMetadata(filePath.current, {
          name: _metadata.name,
          singer: _metadata.singer,
          albumName: _metadata.albumName,
        })
      }
      if (_metadata.pic != metadata.current.pic) {
        isUpdated ||= true
        await writePic(filePath.current, _metadata.pic)
        if (_metadata.pic.startsWith(TEMP_FILE_PATH)) void unlink(_metadata.pic)
      }
    } catch (err: any) {
      log.error(`save (${filePath.current}) metadata failed: \n${err.message}`)
      toast(global.i18n.t('metadata_edit_modal_failed'), 'long')
      return
    } finally {
      setProcessing(false)
    }
    if (isUpdated) toast(global.i18n.t('metadata_edit_modal_success'), 'long')
    dialogRef.current?.setVisible(false)
    props.onUpdate(_metadata)
  }

  return (
    visible
      ? <Dialog
          appearance="media"
          ref={dialogRef}
          title={t('metadata_edit_modal_title')}
          width="90%"
          height="78%"
        >
          <View style={mediaEditStyles.content}>
            <ScrollView keyboardShouldPersistTaps="handled">
              <MetadataForm ref={metadataFormRef} />
            </ScrollView>
            <View style={[mediaEditStyles.footer, { borderTopColor: theme['c-250'] }]}>
              <MediaAction onPress={() => { dialogRef.current?.setVisible(false) }}>{t('cancel')}</MediaAction>
              <MediaAction kind="primary" onPress={() => { void handleUpdate() }} disabled={processing}>
                {processing ? t('metadata_edit_modal_processing') : t('metadata_edit_modal_confirm')}
              </MediaAction>
            </View>
          </View>
        </Dialog>
      : null
  )
})
