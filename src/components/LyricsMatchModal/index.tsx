import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { ScrollView, View } from 'react-native'

import Dialog, { type DialogType } from '@/components/common/Dialog'
import Text from '@/components/common/Text'
import Input, { type InputType } from '@/components/common/Input'
import Button from '@/components/common/Button'
import ButtonPrimary from '@/components/common/ButtonPrimary'
import Loading from '@/components/common/Loading'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { confirmDialog, createStyle, toast } from '@/utils/tools'
import { useUnmounted, useWindowSize } from '@/utils/hooks'
import { existsFile } from '@/utils/fs'
import { applyLrcToMusic, getCandidateLyric, searchLyrics, updateMusicLyricSource } from '@/core/mediaMatch'
import { getLyricPreviewEntries, sanitizeExtendedLyric, type LyricPreviewEntry } from '@/utils/mediaMatch/lrcText'
import { getFileStem, isInstrumentalName, parseIntervalToSec } from '@/utils/mediaMatch/query'
import { checkLrcMatchablePath, LrcFileError } from '@/utils/lrcFile'
import { formatPlayTime2 } from '@/utils/common'
import { log } from '@/utils/log'
import CandidateItem from './CandidateItem'

type SearchState = 'idle' | 'loading' | 'success' | 'error'

interface FetchedLyric {
  lyric: string
  isSynced: boolean
  tlyric?: string
  rlyric?: string
}

export interface LyricsMatchModalType {
  show: (info: { musicInfo: LX.Music.MusicInfo, listId: string }) => void
}

export default forwardRef<LyricsMatchModalType>((props, ref) => {
  const t = useI18n()
  const theme = useTheme()
  const dialogRef = useRef<DialogType>(null)
  const inputRef = useRef<InputType>(null)
  const windowSize = useWindowSize()
  const musicInfoRef = useRef<LX.Music.MusicInfoLocal | null>(null)
  const listIdRef = useRef<string>('')
  const abortRef = useRef<AbortController | null>(null)
  const lyricAbortRef = useRef<AbortController | null>(null)
  const requestSeq = useRef(0)
  const lyricSeq = useRef(0)
  const isUnmounted = useUnmounted()

  const [visible, setVisible] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [searchState, setSearchState] = useState<SearchState>('idle')
  const [candidates, setCandidates] = useState<LX.Music.LyricsCandidate[]>([])
  const [selected, setSelected] = useState<LX.Music.LyricsCandidate | null>(null)
  const [fetchedLyric, setFetchedLyric] = useState<FetchedLyric | null>(null)
  const [lyricUnavailable, setLyricUnavailable] = useState(false)
  const [lyricLoading, setLyricLoading] = useState(false)
  const [preview, setPreview] = useState<LyricPreviewEntry[]>([])
  const [applying, setApplying] = useState(false)
  // 候选列表实测高度：按内容收缩、最多 resultMaxHeight，避免列表内容把预览/按钮顶出弹窗
  const [listHeight, setListHeight] = useState(0)

  useEffect(() => () => {
    abortRef.current?.abort()
    lyricAbortRef.current?.abort()
  }, [])

  const resetState = () => {
    abortRef.current?.abort()
    abortRef.current = null
    lyricAbortRef.current?.abort()
    lyricAbortRef.current = null
    requestSeq.current++
    lyricSeq.current++
    setSearchState('idle')
    setCandidates([])
    setSelected(null)
    setFetchedLyric(null)
    setLyricUnavailable(false)
    setLyricLoading(false)
    setPreview([])
    setApplying(false)
    setListHeight(0)
  }

  const handleHide = () => {
    resetState()
    setVisible(false)
  }

  const startSearch = async(searchKeyword?: string) => {
    const musicInfo = musicInfoRef.current
    if (!musicInfo) return

    abortRef.current?.abort()
    lyricAbortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const seq = ++requestSeq.current
    lyricSeq.current++
    setSearchState('loading')
    setCandidates([])
    setSelected(null)
    setFetchedLyric(null)
    setLyricUnavailable(false)
    setLyricLoading(false)
    setPreview([])
    setListHeight(0)

    try {
      const result = await searchLyrics({ musicInfo, keyword: searchKeyword, signal: controller.signal })
      if (isUnmounted.current || seq !== requestSeq.current || controller.signal.aborted) return
      setCandidates(result)
      // 先按最大高度占位，等列表实测内容高度后再收缩，避免首帧把预览/按钮顶出弹窗
      setListHeight(result.length ? Math.max(96, Math.round(windowSize.height * 0.32)) : 0)
      setSearchState('success')
    } catch (error: any) {
      if (isUnmounted.current || seq !== requestSeq.current || controller.signal.aborted) return
      log.warn(`search lyrics failed: ${error?.message ?? error}`)
      setSearchState('error')
    }
  }

  const fetchLyric = async(candidate: LX.Music.LyricsCandidate, signal: AbortSignal): Promise<FetchedLyric | null> => {
    const result = await getCandidateLyric(candidate, signal)
    if (!result) return null
    return { lyric: result.lyric, isSynced: result.isSynced, tlyric: result.tlyric, rlyric: result.rlyric }
  }

  const applyFetchedLyric = (info: FetchedLyric | null) => {
    setFetchedLyric(info)
    setLyricUnavailable(info == null)
    setPreview(info ? getLyricPreviewEntries(info.lyric, info.tlyric, info.rlyric) : [])
    setLyricLoading(false)
  }

  const updateCandidateSynced = (candidate: LX.Music.LyricsCandidate, info: FetchedLyric) => {
    setCandidates(list => list.map(item => (
      item.source === candidate.source && item.id === candidate.id
        ? { ...item, hasSynced: info.isSynced }
        : item
    )))
  }

  const handleSelect = async(candidate: LX.Music.LyricsCandidate) => {
    lyricAbortRef.current?.abort()
    const controller = new AbortController()
    lyricAbortRef.current = controller
    const seq = ++lyricSeq.current

    setSelected(candidate)
    setFetchedLyric(null)
    setLyricUnavailable(false)
    setPreview([])
    setLyricLoading(true)

    try {
      const info = await fetchLyric(candidate, controller.signal)
      if (isUnmounted.current || seq !== lyricSeq.current || controller.signal.aborted) return
      if (info) {
        applyFetchedLyric(info)
        updateCandidateSynced(candidate, info)
        return
      }

      // 当前候选可能无歌词（QQ -1901 / 纯音乐 / 占位文本）：
      // 沿排序再试最多 4 个候选（跨源），避免自动选中第一条时预览一直为空。
      {
        const currentIndex = candidates.findIndex(item => item.source === candidate.source && item.id === candidate.id)
        const fallbacks = candidates
          .slice(currentIndex + 1)
          .filter(item => !item.instrumental && item.score >= 0.6)
          .slice(0, 4)
        for (const fallback of fallbacks) {
          if (isUnmounted.current || seq !== lyricSeq.current || controller.signal.aborted) return
          const fallbackInfo = await fetchLyric(fallback, controller.signal)
          if (isUnmounted.current || seq !== lyricSeq.current || controller.signal.aborted) return
          if (!fallbackInfo) continue
          setSelected(fallback)
          applyFetchedLyric(fallbackInfo)
          updateCandidateSynced(fallback, fallbackInfo)
          toast(t('lyrics_match_qq_fallback', { name: fallback.name }), 'long')
          return
        }
      }
      applyFetchedLyric(null)
    } catch (error: any) {
      if (isUnmounted.current || seq !== lyricSeq.current || controller.signal.aborted) return
      log.warn(`get candidate lyric failed: ${error?.message ?? error}`)
      applyFetchedLyric(null)
    }
  }

  const getApplyErrorMessage = (error: any): string => {
    const code = error instanceof LrcFileError ? error.code : 'unknown'
    switch (code) {
      case 'permission':
        return t('lyrics_match_error_permission')
      case 'no_space':
        return t('lyrics_match_error_no_space')
      default:
        return t('lyrics_match_error_other', { message: error?.message ?? String(error) })
    }
  }

  const handleApply = async() => {
    const musicInfo = musicInfoRef.current
    const candidate = selected
    const lyric = fetchedLyric
    if (!musicInfo || !candidate || !lyric || applying) return

    const isSuspectInstrumental = isInstrumentalName(musicInfo.name) || isInstrumentalName(getFileStem(musicInfo.meta.filePath))
    if (isSuspectInstrumental) {
      const confirmed = await confirmDialog({
        message: t('lyrics_match_inst_confirm'),
        confirmButtonText: t('lyrics_match_apply'),
      })
      if (!confirmed) return
    }
    if (!lyric.isSynced) {
      const confirmed = await confirmDialog({
        message: t('lyrics_match_plain_confirm'),
        confirmButtonText: t('lyrics_match_apply'),
      })
      if (!confirmed) return
    }

    setApplying(true)
    try {
      const result = await applyLrcToMusic({ musicInfo, candidate, lyric })
      await updateMusicLyricSource({ listId: listIdRef.current, musicInfo, source: 'lrc' })
      const fileName = result.lrcPath.substring(result.lrcPath.lastIndexOf('/') + 1)
      toast(t('lyrics_match_applied', { name: fileName }), 'long')
      dialogRef.current?.setVisible(false)
    } catch (error: any) {
      log.warn(`apply lrc failed: ${error?.message ?? error}`)
      toast(getApplyErrorMessage(error), 'long')
    } finally {
      setApplying(false)
    }
  }

  const open = async(info: { musicInfo: LX.Music.MusicInfo, listId: string }) => {
    const musicInfo = info.musicInfo
    if (musicInfo.source != 'local') {
      toast(t('lyrics_match_only_local'))
      return
    }
    const pathCheck = checkLrcMatchablePath(musicInfo.meta.filePath)
    if (pathCheck === 'uri' || pathCheck === 'invalid') {
      toast(t('lyrics_match_path_uri'), 'long')
      return
    }
    if (pathCheck === 'app_private') {
      toast(t('lyrics_match_path_cache'), 'long')
      return
    }
    if (!(await existsFile(musicInfo.meta.filePath).catch(() => false))) {
      toast(t('lyrics_match_file_missing'), 'long')
      return
    }
    if (isUnmounted.current) return

    musicInfoRef.current = musicInfo
    listIdRef.current = info.listId
    resetState()
    const defaultKeyword = `${musicInfo.name}${musicInfo.singer ? ` ${musicInfo.singer}` : ''}`.trim()
    setKeyword(defaultKeyword)

    if (visible) {
      dialogRef.current?.setVisible(true)
      void startSearch(defaultKeyword)
      return
    }
    setVisible(true)
    requestAnimationFrame(() => {
      dialogRef.current?.setVisible(true)
      void startSearch(defaultKeyword)
    })
  }

  useImperativeHandle(ref, () => ({
    show(info) {
      void open(info)
    },
  }))

  const musicInfo = musicInfoRef.current
  const durationSec = musicInfo ? parseIntervalToSec(musicInfo.interval) : null
  const durationDiff = selected?.durationSec != null && durationSec != null
    ? Math.abs(selected.durationSec - durationSec)
    : null
  const isSuspectInstrumental = musicInfo
    ? isInstrumentalName(musicInfo.name) || isInstrumentalName(getFileStem(musicInfo.meta.filePath))
    : false
  const canApply = !!selected && !!fetchedLyric && !lyricLoading && !applying && searchState !== 'loading'
  const hasTranslation = !!sanitizeExtendedLyric(fetchedLyric?.tlyric)
  const hasRomaji = !!sanitizeExtendedLyric(fetchedLyric?.rlyric)
  // 候选列表固定最大高度（约屏幕 32%），避免与预览区互相抢 flex 空间
  const resultMaxHeight = Math.max(96, Math.round(windowSize.height * 0.30))

  const renderCandidateArea = () => {
    if (searchState === 'loading') {
      return <View style={styles.center}><Loading size={16} label={t('lyrics_match_loading')} /></View>
    }
    if (searchState === 'error') {
      return (
        <View style={styles.center}>
          <Text size={13} color={theme['c-font-label']}>{t('lyrics_match_error')}</Text>
          <ButtonPrimary onPress={() => { void startSearch(keyword) }}>{t('lyrics_match_retry')}</ButtonPrimary>
        </View>
      )
    }
    if (searchState === 'success' && !candidates.length) {
      return <View style={styles.center}><Text size={13} color={theme['c-font-label']}>{t('lyrics_match_empty')}</Text></View>
    }
    return (
      <ScrollView
        style={[styles.listScroll, { maxHeight: resultMaxHeight }, listHeight > 0 ? { height: Math.min(listHeight, resultMaxHeight) } : null]}
        contentContainerStyle={styles.listContent}
        nestedScrollEnabled
        showsVerticalScrollIndicator={false}
        onContentSizeChange={(_, height) => {
          const next = Math.min(Math.ceil(height), resultMaxHeight)
          setListHeight(prev => prev === next ? prev : next)
        }}
      >
        {
          candidates.map(candidate => (
            <CandidateItem
              key={`${candidate.source}_${candidate.id}`}
              candidate={candidate}
              selected={selected?.source === candidate.source && selected.id === candidate.id}
              onPress={candidate => { void handleSelect(candidate) }}
            />
          ))
        }
      </ScrollView>
    )
  }

  return (
    visible
      ? <Dialog ref={dialogRef} title={t('lyrics_match_title')} height={'78%'} width={'90%'} onHide={handleHide}>
          <View style={styles.content} onStartShouldSetResponder={() => true}>
            <View style={styles.searchRow}>
              <View style={styles.searchInputWrap}>
                <Input
                  ref={inputRef}
                  value={keyword}
                  onChangeText={setKeyword}
                  placeholder={t('lyrics_match_search_placeholder')}
                  returnKeyType="search"
                  onSubmitEditing={() => { void startSearch(keyword) }}
                  style={{ ...styles.input, backgroundColor: theme['c-primary-input-background'] }}
                  clearBtn
                />
              </View>
              <View style={styles.searchBtnWrap}>
                <ButtonPrimary disabled={searchState === 'loading'} onPress={() => { void startSearch(keyword) }}>
                  {t('lyrics_match_search')}
                </ButtonPrimary>
              </View>
            </View>
            {isSuspectInstrumental ? <Text size={12} color={theme['c-primary-font']} style={styles.hint}>{t('lyrics_match_suspect_instrumental')}</Text> : null}
            <View style={styles.resultHeader}>
              <Text size={12} color={theme['c-font-label']}>{t('lyrics_match_result_title', { num: candidates.length })}</Text>
            </View>
            <View style={styles.candidateArea}>
              {renderCandidateArea()}
            </View>
            <View style={[styles.divider, { backgroundColor: theme['c-primary-light-200-alpha-400'] }]} />
            <View style={styles.previewArea}>
              <View style={styles.previewHeader}>
                <Text size={12} color={theme['c-font-label']}>{t('lyrics_match_preview')}</Text>
                {hasTranslation ? <Text size={11} color={theme['c-font-label']} style={styles.previewTag}>{t('lyrics_match_translation_available')}</Text> : null}
                {hasRomaji ? <Text size={11} color={theme['c-font-label']} style={styles.previewTag}>{t('lyrics_match_roma_available')}</Text> : null}
              </View>
              {selected?.instrumental
                ? <Text size={12} color={theme['c-primary-font']} style={styles.hint}>{t('lyrics_match_inst_warning')}</Text>
                : null}
              {fetchedLyric && !fetchedLyric.isSynced
                ? <Text size={12} color={theme['c-primary-font']} style={styles.hint}>{t('lyrics_match_plain_tip')}</Text>
                : null}
              {durationDiff != null && durationDiff > 10
                ? <Text size={12} color={theme['c-primary-font']} style={styles.hint}>
                    {t('lyrics_match_duration_diff', {
                      diff: Math.round(durationDiff),
                      candidate: formatPlayTime2(selected!.durationSec!),
                      current: formatPlayTime2(durationSec!),
                    })}
                  </Text>
                : null}
              <ScrollView style={styles.previewScroll} contentContainerStyle={styles.previewContent} nestedScrollEnabled showsVerticalScrollIndicator={false}>
                {
                  lyricLoading
                    ? <Loading size={14} label={t('lyrics_match_lyric_loading')} />
                    : lyricUnavailable
                      ? <Text size={12} color={theme['c-primary-font']}>{t('lyrics_match_no_lyric')}</Text>
                      : preview.length
                        ? preview.map((entry, index) => (
                            <Text
                              key={index}
                              size={entry.type === 'main' ? 12 : 11}
                              color={entry.type === 'main' ? undefined : theme['c-font-label']}
                              selectable
                            >{entry.text}</Text>
                        ))
                        : <Text size={12} color={theme['c-font-label']}>{selected ? t('lyrics_match_preview_empty') : t('lyrics_match_select_tip')}</Text>
                }
              </ScrollView>
            </View>
            <View style={styles.footer}>
              <Button style={{ ...styles.footerBtn, backgroundColor: theme['c-button-background'] }} onPress={() => { dialogRef.current?.setVisible(false) }}>
                <Text color={theme['c-button-font']}>{t('cancel')}</Text>
              </Button>
              <ButtonPrimary disabled={!canApply} onPress={() => { void handleApply() }}>
                {applying ? t('lyrics_match_applying') : t('lyrics_match_apply')}
              </ButtonPrimary>
            </View>
          </View>
        </Dialog>
      : null
  )
})

const styles = createStyle({
  content: {
    flex: 1,
    flexDirection: 'column',
    justifyContent: 'flex-start',
    overflow: 'hidden',
    paddingLeft: 12,
    paddingRight: 12,
    paddingTop: 10,
    paddingBottom: 56,
  },
  searchRow: {
    flexGrow: 0,
    flexShrink: 0,
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
  },
  searchInputWrap: {
    flexGrow: 1,
    flexShrink: 1,
    height: 36,
    justifyContent: 'center',
    marginRight: 10,
  },
  searchBtnWrap: {
    flexGrow: 0,
    flexShrink: 0,
    height: 36,
    justifyContent: 'center',
  },
  input: {
    flexGrow: 1,
    flexShrink: 1,
    borderRadius: 4,
  },
  resultHeader: {
    flexGrow: 0,
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
    marginBottom: 4,
  },
  candidateArea: {
    flexGrow: 0,
    flexShrink: 0,
  },
  listScroll: {
    flexGrow: 0,
    flexShrink: 0,
  },
  listContent: {
    paddingBottom: 2,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 18,
  },
  previewArea: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minHeight: 0,
    marginTop: 6,
  },
  previewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  previewTag: {
    opacity: 0.85,
  },
  divider: {
    height: 1,
    marginTop: 8,
  },
  previewScroll: {
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 0,
    marginTop: 2,
  },
  previewContent: {
    paddingBottom: 8,
  },
  hint: {
    marginTop: 2,
  },
  footer: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 10,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  footerBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 4,
    marginRight: 10,
  },
})
