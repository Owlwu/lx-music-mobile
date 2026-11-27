import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Keyboard, ScrollView, View } from 'react-native'

import Dialog, { type DialogType } from '@/components/common/Dialog'
import Text from '@/components/common/Text'
import Input, { type InputType } from '@/components/common/Input'
import MediaAction from '@/components/MediaEdit/Action'
import { mediaEditStyles } from '@/components/MediaEdit/styles'
import Loading from '@/components/common/Loading'
import Image from '@/components/common/Image'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { confirmDialog, createStyle, toast } from '@/utils/tools'
import { useUnmounted, useWindowSize } from '@/utils/hooks'
import { existsFile } from '@/utils/fs'
import { applyCoverCandidate, getCoverState, refreshPlayingCover, deleteCover, searchCoverCandidates } from '@/core/coverMatch'
import { checkCoverMatchablePath } from '@/utils/coverFile'
import { getFileStem, isInstrumentalName, parseIntervalToSec } from '@/utils/mediaMatch/query'
import { formatPlayTime2 } from '@/utils/common'
import { log } from '@/utils/log'
import CandidateItem from './CandidateItem'

type SearchState = 'idle' | 'loading' | 'success' | 'error'

const emptyCoverState: LX.Music.CoverState = { imageExists: false }

export interface CoverMatchModalType {
  show: (info: { musicInfo: LX.Music.MusicInfo, listId: string }) => void
}

export default forwardRef<CoverMatchModalType>((props, ref) => {
  const t = useI18n()
  const theme = useTheme()
  const dialogRef = useRef<DialogType>(null)
  const inputRef = useRef<InputType>(null)
  const windowSize = useWindowSize()
  const musicInfoRef = useRef<LX.Music.MusicInfoLocal | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const requestSeq = useRef(0)
  const coverStateSeq = useRef(0)
  const isUnmounted = useUnmounted()

  const [visible, setVisible] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [searchState, setSearchState] = useState<SearchState>('idle')
  const [candidates, setCandidates] = useState<LX.Music.CoverCandidate[]>([])
  const [selected, setSelected] = useState<LX.Music.CoverCandidate | null>(null)
  const [coverState, setCoverState] = useState<LX.Music.CoverState>(emptyCoverState)
  const [applying, setApplying] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [listHeight, setListHeight] = useState(0)
  const [resultsAreaHeight, setResultsAreaHeight] = useState(0)

  useEffect(() => () => {
    abortRef.current?.abort()
  }, [])

  const resetState = () => {
    abortRef.current?.abort()
    abortRef.current = null
    requestSeq.current++
    coverStateSeq.current++
    setSearchState('idle')
    setCandidates([])
    setSelected(null)
    setCoverState(emptyCoverState)
    setApplying(false)
    setDeleting(false)
    setListHeight(0)
  }

  const handleHide = () => {
    resetState()
    setVisible(false)
  }

  const refreshCoverState = async(musicInfo: LX.Music.MusicInfoLocal) => {
    const seq = ++coverStateSeq.current
    let state: LX.Music.CoverState
    try {
      state = await getCoverState(musicInfo)
    } catch (error: any) {
      log.warn(`get cover state failed: ${error?.message ?? error}`)
      state = emptyCoverState
    }
    if (isUnmounted.current || seq !== coverStateSeq.current) return
    setCoverState(state)
  }

  const startSearch = async(searchKeyword?: string) => {
    const musicInfo = musicInfoRef.current
    if (!musicInfo) return
    Keyboard.dismiss()

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const seq = ++requestSeq.current
    setSearchState('loading')
    setCandidates([])
    setSelected(null)
    setListHeight(0)

    try {
      const result = await searchCoverCandidates({ musicInfo, keyword: searchKeyword, signal: controller.signal })
      if (isUnmounted.current || seq !== requestSeq.current || controller.signal.aborted) return
      setCandidates(result)
      setSearchState('success')
    } catch (error: any) {
      if (isUnmounted.current || seq !== requestSeq.current || controller.signal.aborted) return
      log.warn(`search cover candidates failed: ${error?.message ?? error}`)
      setSearchState('error')
    }
  }

  const getErrorMessage = (error: any): string => {
    const code = error?.code
    switch (code) {
      case 'permission':
      case 'no_permission':
        return t('cover_match_error_permission')
      case 'no_space':
      case 'disk_full':
        return t('cover_match_error_no_space')
      case 'image_invalid':
        return t('cover_match_image_invalid')
      case 'image_too_large':
        return t('cover_match_image_too_large')
      case 'download_failed':
        return t('cover_match_download_failed')
      case 'invalid_file':
        // 音频被移走/候选非法；展示可读文案，不把技术信息透给用户
        return t('cover_match_file_missing')
      default:
        return t('cover_match_error_other', { message: error?.message ?? String(error) })
    }
  }

  const handleApply = async() => {
    const musicInfo = musicInfoRef.current
    const candidate = selected
    if (!musicInfo || !candidate || applying || deleting) return

    setApplying(true)
    try {
      if (coverState.imageExists) {
        const confirmed = await confirmDialog({
          message: t('cover_match_replace_confirm'),
          confirmButtonText: t('cover_match_apply'),
        })
        if (!confirmed) return
      }
      const result = await applyCoverCandidate({ musicInfo, candidate })
      const fileName = result.imagePath.substring(result.imagePath.lastIndexOf('/') + 1)
      toast(t('cover_match_apply_success', { file: fileName }), 'long')
      await refreshPlayingCover(musicInfo).catch((error: any) => {
        log.warn(`refresh playing cover failed: ${error?.message ?? error}`)
      })
      dialogRef.current?.setVisible(false)
    } catch (error: any) {
      log.warn(`apply cover failed: ${error?.message ?? error}`)
      toast(getErrorMessage(error), 'long')
    } finally {
      if (!isUnmounted.current) setApplying(false)
    }
  }

  const handleDelete = async() => {
    const musicInfo = musicInfoRef.current
    if (!musicInfo || !coverState.imageExists || applying || deleting) return

    setDeleting(true)
    try {
      const confirmed = await confirmDialog({
        message: t('cover_match_delete_confirm'),
        confirmButtonText: t('cover_match_delete'),
      })
      if (!confirmed) return

      const deleted = await deleteCover(musicInfo)
      await refreshPlayingCover(musicInfo)
      toast(deleted ? t('cover_match_delete_success') : t('cover_match_delete_none'))
    } catch (error: any) {
      log.warn(`delete cover failed: ${error?.message ?? error}`)
      toast(getErrorMessage(error), 'long')
    } finally {
      if (musicInfoRef.current === musicInfo) await refreshCoverState(musicInfo)
      if (!isUnmounted.current) setDeleting(false)
    }
  }

  const open = async(info: { musicInfo: LX.Music.MusicInfo, listId: string }) => {
    const musicInfo = info.musicInfo
    if (musicInfo.source != 'local') {
      toast(t('cover_match_only_local'))
      return
    }
    const pathCheck = checkCoverMatchablePath(musicInfo.meta.filePath)
    if (pathCheck === 'uri' || pathCheck === 'invalid') {
      toast(t('cover_match_path_uri'), 'long')
      return
    }
    if (pathCheck === 'app_private') {
      toast(t('cover_match_path_cache'), 'long')
      return
    }
    if (!(await existsFile(musicInfo.meta.filePath).catch(() => false))) {
      toast(t('cover_match_file_missing'), 'long')
      return
    }
    if (isUnmounted.current) return

    musicInfoRef.current = musicInfo
    resetState()
    const defaultKeyword = `${musicInfo.name}${musicInfo.singer ? ` ${musicInfo.singer}` : ''}`.trim()
    setKeyword(defaultKeyword)
    void refreshCoverState(musicInfo)

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
  const selectedInstrumental = isInstrumentalName(selected?.name)
  const canApply = !!selected && !applying && !deleting && searchState !== 'loading'
  const canDelete = coverState.imageExists && !applying && !deleting
  const resultMaxHeight = Math.floor(resultsAreaHeight * 0.40)
  const previewSize = Math.min(
    Math.round(windowSize.width * 0.90) - 40,
    Math.round(windowSize.height * 0.20),
  )

  const renderCandidateArea = () => {
    if (searchState === 'loading') {
      return <View style={styles.center}><Loading size={16} label={t('cover_match_loading')} /></View>
    }
    if (searchState === 'error') {
      return (
        <View style={styles.center}>
          <Text size={13} color={theme['c-font-label']}>{t('cover_match_error')}</Text>
          <MediaAction onPress={() => { void startSearch(keyword) }}>{t('cover_match_retry')}</MediaAction>
        </View>
      )
    }
    if (!candidates.length) {
      return searchState === 'success'
        ? <View style={styles.center}><Text size={13} color={theme['c-font-label']}>{t('cover_match_empty')}</Text></View>
        : null
    }
    return (
      <ScrollView
        style={[styles.listScroll, { height: Math.min(listHeight || resultMaxHeight, resultMaxHeight) }]}
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={(_, height) => {
          setListHeight(Math.ceil(height))
        }}
      >
        {
          candidates.map(candidate => (
            <CandidateItem
              key={`${candidate.source}_${candidate.id}`}
              candidate={candidate}
              selected={selected?.source === candidate.source && selected.id === candidate.id}
              onPress={candidate => {
                Keyboard.dismiss()
                setSelected(candidate)
              }}
            />
          ))
        }
      </ScrollView>
    )
  }

  return (
    visible
      ? <Dialog appearance="media" ref={dialogRef} title={t('cover_match_title')} height={'78%'} width={'90%'} onHide={handleHide}>
          <View style={mediaEditStyles.content}>
            <View style={styles.searchRow}>
              <View style={styles.searchInputWrap}>
                <Input
                  ref={inputRef}
                  value={keyword}
                  onChangeText={setKeyword}
                  placeholder={t('cover_match_search_placeholder')}
                  returnKeyType="search"
                  onSubmitEditing={() => { void startSearch(keyword) }}
                  style={[mediaEditStyles.field, mediaEditStyles.searchField, { backgroundColor: theme['c-primary-input-background'] }]}
                  clearBtn
                />
              </View>
              <View style={styles.searchBtnWrap}>
                <MediaAction disabled={searchState === 'loading'} onPress={() => { void startSearch(keyword) }}>
                  {t('cover_match_search')}
                </MediaAction>
              </View>
            </View>
            {isSuspectInstrumental ? <Text size={12} color={theme['c-primary-font']} style={styles.hint}>{t('cover_match_suspect_instrumental')}</Text> : null}
            <View style={styles.resultHeader}>
              <Text size={13} style={mediaEditStyles.title} color={theme['c-font-label']}>{t('cover_match_result_title', { num: candidates.length })}</Text>
            </View>
            <View style={styles.resultsAndPreview} onLayout={({ nativeEvent }) => { setResultsAreaHeight(nativeEvent.layout.height) }}>
              {renderCandidateArea()}
              <View style={[styles.divider, { backgroundColor: theme['c-primary-light-200-alpha-400'] }]} />
              <Text size={13} style={mediaEditStyles.title} color={theme['c-font-label']}>{t('cover_match_preview')}</Text>
              <ScrollView
                key={selected ? `${selected.source}_${selected.id}` : undefined}
                style={styles.previewScroll}
                contentContainerStyle={styles.previewContent}
              >
                {selected?.albumName
                  ? <Text size={12} color={theme['c-font-label']} style={styles.album}>{t('cover_match_album', { album: selected.albumName })}</Text>
                  : null}
                {selectedInstrumental
                  ? <Text size={12} color={theme['c-primary-font']} style={styles.hint}>{t('cover_match_inst_warning')}</Text>
                  : null}
                {durationDiff != null && durationDiff > 10
                  ? <Text size={12} color={theme['c-primary-font']} style={styles.hint}>
                      {t('cover_match_duration_diff', {
                        diff: Math.round(durationDiff),
                        candidate: formatPlayTime2(selected!.durationSec!),
                        current: formatPlayTime2(durationSec!),
                      })}
                    </Text>
                  : null}
                {selected
                  ? <Image url={selected.coverUrl} style={{ width: previewSize, height: previewSize, borderRadius: 4 }} resizeMode="contain" />
                  : <Text size={12} color={theme['c-font-label']}>{t('cover_match_select_tip')}</Text>}
              </ScrollView>
            </View>
            <Text size={11} color={theme['c-font-label']}>{t('cover_match_apply_tip')}</Text>
            <View style={[mediaEditStyles.footer, { borderTopColor: theme['c-border-background'] }]}>
              {coverState.imageExists
                ? <MediaAction kind="danger" disabled={!canDelete} onPress={() => { void handleDelete() }}>
                    {deleting ? t('cover_match_deleting') : t('cover_match_delete')}
                  </MediaAction>
                : null}
              <MediaAction disabled={applying || deleting} onPress={() => { dialogRef.current?.setVisible(false) }}>{t('cancel')}</MediaAction>
              <MediaAction kind="primary" disabled={!canApply} onPress={() => { void handleApply() }}>
                {applying ? t('cover_match_applying') : t('cover_match_apply')}
              </MediaAction>
            </View>
          </View>
        </Dialog>
      : null
  )
})

const styles = createStyle({
  searchRow: {
    flexGrow: 0,
    flexShrink: 0,
    height: 46,
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
  resultHeader: {
    flexGrow: 0,
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
    marginBottom: 4,
  },
  resultsAndPreview: {
    flex: 1,
    minHeight: 0,
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
  previewScroll: {
    flex: 1,
    minHeight: 0,
  },
  previewContent: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    gap: 8,
  },
  album: {
    textAlign: 'center',
  },
  divider: {
    height: 1,
    marginTop: 6,
    marginBottom: 6,
  },
  hint: {
    marginTop: 2,
  },
})
