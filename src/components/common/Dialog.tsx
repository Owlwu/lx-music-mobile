import { useImperativeHandle, forwardRef, useMemo, useRef } from 'react'
import { Pressable, StyleSheet, View, TouchableHighlight } from 'react-native'

import Modal, { type ModalType } from './Modal'
import { Icon } from '@/components/common/Icon'
import { useKeyboard } from '@/utils/hooks'
import { createStyle } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'
import Text from './Text'
import { useI18n } from '@/lang'
import { scaleSizeH } from '@/utils/pixelRatio'

const HEADER_HEIGHT = 20
const styles = createStyle({
  centeredView: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalView: {
    maxWidth: '90%',
    minWidth: '60%',
    maxHeight: '78%',
    // backgroundColor: 'white',
    borderRadius: 4,
    overflow: 'hidden',
    // shadowColor: '#000',
    // shadowOffset: {
    //   width: 0,
    //   height: 2,
    // },
    // shadowOpacity: 0.25,
    // shadowRadius: 4,
    elevation: 3,
  },
  header: {
    flexGrow: 0,
    flexShrink: 0,
    flexDirection: 'row',
    borderTopLeftRadius: 4,
    borderTopRightRadius: 4,
    height: HEADER_HEIGHT,
  },
  title: {
    paddingLeft: 5,
    paddingRight: 25,
    lineHeight: HEADER_HEIGHT,
  },
  mediaHeader: {
    minHeight: 44,
    paddingLeft: 12,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  mediaTitle: {
    flex: 1,
    fontWeight: '600',
  },
  mediaClose: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeBtn: {
    position: 'absolute',
    right: 0,
    borderTopRightRadius: 4,
    flexGrow: 0,
    flexShrink: 0,
    height: HEADER_HEIGHT,
    justifyContent: 'center',
    alignItems: 'center',
  },
})

export interface DialogProps {
  onHide?: () => void
  keyHide?: boolean
  bgHide?: boolean
  closeBtn?: boolean
  appearance?: 'media'
  title?: string
  children: React.ReactNode | React.ReactNode[]
  height?: number | `${number}%`
  /**
   * 固定宽度；不传时按 60%~90% 自适应内容（不同内容会导致宽度跳动）
   */
  width?: number | `${number}%`
}

export interface DialogType {
  setVisible: (visible: boolean) => void
}

export default forwardRef<DialogType, DialogProps>(({
  onHide,
  keyHide = true,
  bgHide = true,
  closeBtn = true,
  title = '',
  appearance,
  children,
  height,
  width,
}: DialogProps, ref) => {
  const theme = useTheme()
  const t = useI18n()
  const isMedia = appearance === 'media'
  const { keyboardShown, keyboardHeight } = useKeyboard()
  const modalRef = useRef<ModalType>(null)

  useImperativeHandle(ref, () => ({
    setVisible(visible: boolean) {
      modalRef.current?.setVisible(visible)
    },
  }))

  const closeBtnComponent = useMemo(() => {
    return closeBtn
      ? <TouchableHighlight accessibilityRole="button" accessibilityLabel={t('close')} style={isMedia ? styles.mediaClose : { ...styles.closeBtn, width: scaleSizeH(HEADER_HEIGHT) }} underlayColor={theme['c-primary-dark-200-alpha-600']} onPress={() => modalRef.current?.setVisible(false)}>
          <Icon name="close" color={theme['c-primary-dark-500-alpha-500']} size={isMedia ? 14 : 10} />
        </TouchableHighlight>
      : null
  }, [closeBtn, isMedia, t, theme])

  return (
    <Modal onHide={onHide} keyHide={keyHide} bgHide={false} bgColor="rgba(50,50,50,.3)" ref={modalRef}>
      <View style={{ ...styles.centeredView, paddingBottom: keyboardShown ? keyboardHeight : 0 }}>
        {/* 遮罩和弹窗并列，弹窗内的列表可以直接处理滚动手势。 */}
        {bgHide ? <Pressable style={StyleSheet.absoluteFill} accessible={false} onPress={() => modalRef.current?.setVisible(false)} /> : null}
        <View style={{
          ...styles.modalView,
          maxWidth: width ? undefined : '90%',
          minWidth: width ? undefined : '60%',
          width,
          maxHeight: height ? undefined : '78%',
          height,
          backgroundColor: theme['c-content-background'],
          borderRadius: isMedia ? 14 : styles.modalView.borderRadius,
        }}>
          <View style={isMedia ? [styles.mediaHeader, { backgroundColor: theme['c-primary-light-100-alpha-100'], borderBottomColor: theme['c-border-background'] }] : { ...styles.header, backgroundColor: theme['c-primary-light-100-alpha-100'] }}>
            <Text
              accessibilityRole={isMedia ? 'header' : undefined}
              style={isMedia ? styles.mediaTitle : styles.title}
              size={isMedia ? 16 : 13}
              color={theme['c-primary-light-1000']}
              numberOfLines={1}
            >{title}</Text>
            {closeBtnComponent}
          </View>
          {children}
        </View>
      </View>
    </Modal>
  )
})
