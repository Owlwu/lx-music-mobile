import { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Animated, PanResponder, StyleSheet, View } from 'react-native'
import { useI18n } from '@/lang'
import { useTheme } from '@/store/theme/hook'

const MIN_THUMB_HEIGHT = 48
const COLLAPSE_DELAY = 1200
const DRAG_THRESHOLD = 2

const clamp = (value: number, max: number) => Math.max(0, Math.min(value, max))

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
  const [expanded, setExpanded] = useState(false)
  const [offset] = useState(() => new Animated.Value(0))
  const currentOffset = useRef(0)
  const drag = useRef<{ startOffset: number, moved: boolean } | null>(null)
  const targetOffset = useRef(0)
  const frame = useRef<number>()
  const collapseTimer = useRef<ReturnType<typeof setTimeout>>()

  const maxOffset = Math.max(0, contentHeight - viewportHeight)
  const thumbHeight = maxOffset > 0
    ? Math.max(MIN_THUMB_HEIGHT, Math.round(viewportHeight * viewportHeight / contentHeight))
    : viewportHeight
  const travel = Math.max(0, viewportHeight - thumbHeight)
  const thumbTop = useMemo(() => offset.interpolate({
    inputRange: [0, maxOffset || 1],
    outputRange: [0, travel],
    extrapolate: 'clamp',
  }), [offset, maxOffset, travel])

  const updateOffset = useCallback((nextOffset: number) => {
    currentOffset.current = nextOffset
    offset.setValue(nextOffset)
  }, [offset])

  const cancelInteraction = useCallback(() => {
    drag.current = null
    if (frame.current != null) cancelAnimationFrame(frame.current)
    frame.current = undefined
    clearTimeout(collapseTimer.current)
  }, [])

  useLayoutEffect(() => {
    setExpanded(false)
    return cancelInteraction
  }, [cancelInteraction, maxOffset, travel])

  useImperativeHandle(ref, () => ({
    syncOffset(nextOffset) {
      if (drag.current == null && frame.current == null) updateOffset(nextOffset)
    },
    reset() {
      cancelInteraction()
      setExpanded(false)
      updateOffset(0)
    },
  }), [cancelInteraction, updateOffset])

  const scrollTo = useCallback((nextOffset: number) => {
    if (nextOffset == currentOffset.current) return
    updateOffset(nextOffset)
    onScrollTo(nextOffset)
  }, [onScrollTo, updateOffset])

  const showTemporarily = useCallback(() => {
    setExpanded(true)
    clearTimeout(collapseTimer.current)
    collapseTimer.current = setTimeout(() => { setExpanded(false) }, COLLAPSE_DELAY)
  }, [])

  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: () => {
      clearTimeout(collapseTimer.current)
      drag.current = { startOffset: clamp(currentOffset.current, maxOffset), moved: false }
      setExpanded(true)
    },
    onPanResponderMove: (_, { dy }) => {
      const activeDrag = drag.current
      if (activeDrag == null || (!activeDrag.moved && Math.abs(dy) < DRAG_THRESHOLD)) return
      activeDrag.moved = true

      targetOffset.current = clamp(activeDrag.startOffset + dy / travel * maxOffset, maxOffset)
      if (frame.current != null) return
      frame.current = requestAnimationFrame(() => {
        frame.current = undefined
        scrollTo(targetOffset.current)
      })
    },
    onPanResponderRelease: () => {
      if (drag.current == null) return
      drag.current = null
      showTemporarily()
    },
    onPanResponderTerminationRequest: () => false,
    onPanResponderTerminate: () => {
      cancelInteraction()
      setExpanded(false)
    },
  }), [cancelInteraction, maxOffset, scrollTo, showTemporarily, travel])

  if (!travel) return null

  return (
    <View style={styles.gutter} pointerEvents="box-none">
      {expanded && <View pointerEvents="none" style={[styles.track, { backgroundColor: theme['c-primary-alpha-900'] }]} />}
      <Animated.View
        {...panResponder.panHandlers}
        style={[styles.thumbTouchArea, { height: thumbHeight, transform: [{ translateY: thumbTop }] }]}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={t('list_fast_scroll')}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={({ nativeEvent: { actionName } }) => {
          const step = actionName == 'increment' ? viewportHeight : -viewportHeight
          scrollTo(clamp(currentOffset.current + step, maxOffset))
          showTemporarily()
        }}
      >
        <View
          pointerEvents="none"
          style={expanded
            ? [styles.expandedThumb, { backgroundColor: theme['c-primary-alpha-200'] }]
            : [styles.idleThumb, { backgroundColor: theme['c-350'] }]}
        />
      </Animated.View>
    </View>
  )
})

const styles = StyleSheet.create({
  gutter: {
    width: 24,
  },
  track: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 4,
    width: 16,
    borderRadius: 8,
  },
  thumbTouchArea: {
    position: 'absolute',
    top: 0,
    right: 0,
    left: 0,
  },
  idleThumb: {
    position: 'absolute',
    right: 4,
    top: 0,
    bottom: 0,
    width: 3,
    borderRadius: 2,
  },
  expandedThumb: {
    position: 'absolute',
    right: 4,
    top: 0,
    bottom: 0,
    width: 16,
    borderRadius: 8,
  },
})
