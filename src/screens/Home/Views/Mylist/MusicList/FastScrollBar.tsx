import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import Slider from '@react-native-community/slider'
import { useI18n } from '@/lang'
import { useTheme } from '@/store/theme/hook'

const GUTTER_WIDTH = 28

interface FastScrollBarProps {
  viewportHeight: number
  contentHeight: number
  onScrollTo: (offset: number) => void
}

export interface FastScrollBarType {
  syncOffset: (offset: number) => void
  reset: () => void
}

export default forwardRef<FastScrollBarType, FastScrollBarProps>(({ viewportHeight, contentHeight, onScrollTo }, ref) => {
  const theme = useTheme()
  const t = useI18n()
  const [offset, setOffset] = useState(0)
  const [isDragging, setIsDragging] = useState(false)
  const dragging = useRef(false)
  const maxOffset = Math.max(0, contentHeight - viewportHeight)

  useImperativeHandle(ref, () => ({
    syncOffset(nextOffset) {
      if (!dragging.current) setOffset(nextOffset)
    },
    reset() {
      dragging.current = false
      setIsDragging(false)
      setOffset(0)
    },
  }), [])

  if (!maxOffset || !viewportHeight) return null

  const jumpTo = (position: number) => {
    const nextOffset = Math.max(0, Math.min(position, maxOffset))
    setOffset(nextOffset)
    onScrollTo(nextOffset)
  }

  return (
    <View style={styles.gutter}>
      <Slider
        accessibilityLabel={t('list_fast_scroll')}
        minimumValue={0}
        maximumValue={maxOffset}
        step={1}
        value={Math.min(offset, maxOffset)}
        minimumTrackTintColor={isDragging ? theme['c-primary-alpha-900'] : 'transparent'}
        maximumTrackTintColor={isDragging ? theme['c-primary-alpha-900'] : 'transparent'}
        thumbTintColor={isDragging ? theme['c-primary-alpha-200'] : theme['c-350']}
        style={[
          styles.slider,
          {
            width: viewportHeight,
            left: (GUTTER_WIDTH - viewportHeight) / 2,
            top: (viewportHeight - GUTTER_WIDTH) / 2,
          },
        ]}
        onSlidingStart={() => {
          dragging.current = true
          setIsDragging(true)
        }}
        onValueChange={position => {
          // 键盘和读屏调节没有触摸开始及结束事件。
          if (!dragging.current) jumpTo(position)
        }}
        onSlidingComplete={position => {
          dragging.current = false
          setIsDragging(false)
          jumpTo(position)
        }}
      />
    </View>
  )
})

const styles = StyleSheet.create({
  gutter: {
    width: GUTTER_WIDTH,
  },
  slider: {
    position: 'absolute',
    height: GUTTER_WIDTH,
    transform: [{ rotate: '90deg' }],
  },
})
