import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { View } from 'react-native'

import Dialog, { type DialogType } from '@/components/common/Dialog'
import Text from '@/components/common/Text'
import MediaAction from '@/components/MediaEdit/Action'
import { mediaEditStyles } from '@/components/MediaEdit/styles'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { createStyle } from '@/utils/tools'
import { log } from '@/utils/log'
import { runBatchMatch, type BatchMatchProgress, type BatchMatchResult, type BatchMatchReview } from '@/core/batchMatch'

export interface BatchMatchModalType {
  show: (info: { listId: string }) => void
}

type BatchView =
  | { type: 'starting' }
  | { type: 'progress', progress: BatchMatchProgress }
  | { type: 'review', review: BatchMatchReview }
  | { type: 'result', result: BatchMatchResult }
  | { type: 'error' }

export default forwardRef<BatchMatchModalType>((props, ref) => {
  const t = useI18n()
  const theme = useTheme()
  const dialogRef = useRef<DialogType>(null)
  const abortRef = useRef<AbortController | null>(null)
  const reviewRef = useRef<((confirmed: boolean) => void) | null>(null)
  const [visible, setVisible] = useState(false)
  const [view, setView] = useState<BatchView>({ type: 'starting' })

  const stop = () => {
    abortRef.current?.abort()
    abortRef.current = null
    reviewRef.current?.(false)
    reviewRef.current = null
  }

  useEffect(() => stop, [])

  const close = () => {
    stop()
    setVisible(false)
  }

  const respondToReview = (confirmed: boolean) => {
    const respond = reviewRef.current
    reviewRef.current = null
    respond?.(confirmed)
  }

  const start = async(listId: string, controller: AbortController) => {
    try {
      const result = await runBatchMatch({
        listId,
        signal: controller.signal,
        confirmTargets: async(review) => {
          if (controller.signal.aborted) return false
          return new Promise<boolean>(resolve => {
            reviewRef.current = resolve
            setView({ type: 'review', review })
          })
        },
        onProgress: progress => {
          if (!controller.signal.aborted) setView({ type: 'progress', progress })
        },
      })
      if (abortRef.current === controller) setView({ type: 'result', result })
    } catch (error: any) {
      log.warn(`batch match failed: ${error?.message ?? error}`)
      if (abortRef.current === controller) setView({ type: 'error' })
    }
  }

  useImperativeHandle(ref, () => ({
    show({ listId }) {
      if (abortRef.current) return
      const controller = new AbortController()
      abortRef.current = controller
      setView({ type: 'starting' })
      setVisible(true)
      requestAnimationFrame(() => {
        if (controller.signal.aborted) return
        dialogRef.current?.setVisible(true)
        void start(listId, controller)
      })
    },
  }))

  const cancel = () => {
    if (view.type === 'review') {
      respondToReview(false)
      dialogRef.current?.setVisible(false)
    } else if (view.type === 'result' || view.type === 'error') {
      dialogRef.current?.setVisible(false)
    } else {
      abortRef.current?.abort()
    }
  }

  const message = () => {
    switch (view.type) {
      case 'review':
        return t('batch_match__confirm', { ...view.review })
      case 'error':
        return t('batch_match__error')
      case 'result': {
        const { result } = view
        if (result.canceled) return t('batch_match__canceled', { done: result.processed })
        if (!result.localTotal) return t('batch_match__no_local')
        if (!result.total) return t('batch_match__none')
        return t('batch_match__summary', { ...result })
      }
      case 'progress': {
        const { progress } = view
        return t(progress.phase === 'scanning' ? 'batch_match__scan_current' : 'batch_match__match_current', {
          current: progress.current,
          total: progress.total,
          name: progress.name,
        })
      }
      default:
        return t('batch_match__scanning')
    }
  }

  const isFinished = view.type === 'result' || view.type === 'error'

  return visible
    ? <Dialog appearance="media" ref={dialogRef} title={t('batch_match__title')} width="90%" bgHide={false} keyHide={false} closeBtn={false} onHide={close}>
        <View style={styles.content}>
          <Text size={14}>{message()}</Text>
          {view.type === 'progress' && view.progress.phase === 'matching'
            ? <Text size={12} color={theme['c-700']} style={styles.detail}>{t('batch_match__progress_counts', { ...view.progress })}</Text>
            : null}
          <View style={[mediaEditStyles.footer, { borderTopColor: theme['c-250'] }]}>
            <MediaAction onPress={cancel}>{t(isFinished ? 'close' : 'batch_match__cancel')}</MediaAction>
            {view.type === 'review'
              ? <MediaAction kind="primary" onPress={() => { respondToReview(true) }}>{t('batch_match__btn_short')}</MediaAction>
              : null}
          </View>
        </View>
      </Dialog>
    : null
})

const styles = createStyle({
  content: {
    padding: 12,
  },
  detail: {
    marginTop: 8,
  },
})
