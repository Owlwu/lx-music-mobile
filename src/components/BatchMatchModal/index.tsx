import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { View } from 'react-native'

import Dialog, { type DialogType } from '@/components/common/Dialog'
import Text from '@/components/common/Text'
import Button from '@/components/common/Button'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { createStyle, tipDialog, toast } from '@/utils/tools'
import { useUnmounted } from '@/utils/hooks'
import { log } from '@/utils/log'
import { runBatchMatch, type BatchMatchCounts, type BatchMatchPhase, type BatchMatchResult } from '@/core/batchMatch'

/**
 * 一键补全进度弹窗（契约 §2.2）：
 * - 扫描阶段：`batch_match__scanning` + `batch_match__scan_current`（{current}/{total}、歌曲名）；
 * - 补全阶段：`batch_match__matching` + `batch_match__match_current` + 实时成功/失败/跳过计数；
 * - 「取消」只停止开始新歌曲，等当前歌曲结束即收尾（AbortSignal 透传给搜索请求）；
 * - 结束：canceled → `batch_match__canceled`；无待处理 → `batch_match__none`；否则 `batch_match__summary`。
 */

export interface BatchMatchModalType {
  show: (info: { listId: string }) => void
}

const emptyCounts = (): BatchMatchCounts => ({ lyric: 0, cover: 0, failed: 0, skipped: 0 })

export default forwardRef<BatchMatchModalType>((props, ref) => {
  const t = useI18n()
  const theme = useTheme()
  const dialogRef = useRef<DialogType>(null)
  const abortRef = useRef<AbortController | null>(null)
  const runSeq = useRef(0)
  const isUnmounted = useUnmounted()

  const [visible, setVisible] = useState(false)
  const [running, setRunning] = useState(false)
  const [phase, setPhase] = useState<BatchMatchPhase>('scanning')
  const [current, setCurrent] = useState(0)
  const [total, setTotal] = useState(0)
  const [name, setName] = useState('')
  const [counts, setCounts] = useState<BatchMatchCounts>(emptyCounts)

  useEffect(() => () => {
    abortRef.current?.abort()
  }, [])

  const resetState = () => {
    setRunning(false)
    setPhase('scanning')
    setCurrent(0)
    setTotal(0)
    setName('')
    setCounts(emptyCounts())
  }

  const handleHide = () => {
    // 手动关闭/程序关闭都中止批次，并让仍在进行的收尾逻辑失效
    runSeq.current++
    abortRef.current?.abort()
    abortRef.current = null
    resetState()
    setVisible(false)
  }

  const handleCancel = () => {
    abortRef.current?.abort()
  }

  const finish = async(result: BatchMatchResult, seq: number) => {
    if (isUnmounted.current || seq !== runSeq.current) return
    setRunning(false)
    // 先关闭进度弹窗（触发 handleHide 清理），再展示结果
    dialogRef.current?.setVisible(false)
    if (result.canceled) {
      toast(t('batch_match__canceled', { done: result.processed }), 'long')
      return
    }
    if (!result.total) {
      toast(t('batch_match__none'), 'long')
      return
    }
    await tipDialog({
      title: t('batch_match__title'),
      message: t('batch_match__summary', {
        lyric: result.lyric,
        cover: result.cover,
        failed: result.failed,
        skipped: result.skipped,
      }),
      btnText: t('ok'),
    })
  }

  const start = async(listId: string, seq: number) => {
    let result: BatchMatchResult | null = null
    try {
      result = await runBatchMatch({
        listId,
        signal: abortRef.current?.signal,
        onProgress: (progress) => {
          if (isUnmounted.current || seq !== runSeq.current) return
          setPhase(progress.phase)
          setCurrent(progress.current)
          setTotal(progress.total)
          setName(progress.name)
          setCounts({
            lyric: progress.lyric,
            cover: progress.cover,
            failed: progress.failed,
            skipped: progress.skipped,
          })
        },
      })
    } catch (error: any) {
      log.warn(`batch match failed: ${error?.message ?? error}`)
    }
    if (isUnmounted.current || seq !== runSeq.current) return
    if (!result) {
      dialogRef.current?.setVisible(false)
      toast(t('batch_match__none'), 'long')
      return
    }
    await finish(result, seq)
  }

  const open = (info: { listId: string }) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const seq = ++runSeq.current
    resetState()
    setRunning(true)

    if (visible) {
      dialogRef.current?.setVisible(true)
      void start(info.listId, seq)
      return
    }
    setVisible(true)
    requestAnimationFrame(() => {
      dialogRef.current?.setVisible(true)
      void start(info.listId, seq)
    })
  }

  useImperativeHandle(ref, () => ({
    show(info) {
      open(info)
    },
  }))

  const currentLine = phase === 'scanning'
    ? t('batch_match__scan_current', { current, total, name })
    : t('batch_match__match_current', { current, total, name })

  return (
    visible
      ? <Dialog ref={dialogRef} title={t('batch_match__title')} width={'84%'} keyHide={false} bgHide={false} onHide={handleHide}>
          <View style={styles.content} onStartShouldSetResponder={() => true}>
            <Text size={13}>{phase === 'scanning' ? t('batch_match__scanning') : t('batch_match__matching')}</Text>
            <Text size={12} color={theme['c-font-label']} style={styles.line} numberOfLines={1}>{currentLine}</Text>
            {
              phase === 'matching'
                ? <Text size={12} color={theme['c-font-label']} style={styles.line}>
                    {t('batch_match__progress_counts', {
                      lyric: counts.lyric,
                      cover: counts.cover,
                      failed: counts.failed,
                      skipped: counts.skipped,
                    })}
                  </Text>
                : null
            }
            <View style={styles.footer}>
              <Button
                style={{ ...styles.cancelBtn, backgroundColor: theme['c-button-background'] }}
                onPress={handleCancel}
                disabled={!running}
              >
                <Text color={theme['c-button-font']}>{t('batch_match__cancel')}</Text>
              </Button>
            </View>
          </View>
        </Dialog>
      : null
  )
})

const styles = createStyle({
  content: {
    paddingLeft: 16,
    paddingRight: 16,
    paddingTop: 14,
    paddingBottom: 12,
  },
  line: {
    marginTop: 8,
  },
  footer: {
    marginTop: 16,
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  cancelBtn: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 4,
  },
})
