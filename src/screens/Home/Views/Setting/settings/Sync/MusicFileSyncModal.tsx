import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { ScrollView, View } from 'react-native'

import Popup, { type PopupType } from '@/components/common/Popup'
import CheckBox from '@/components/common/CheckBox'
import Text from '@/components/common/Text'
import Button from '../../components/Button'
import { createStyle } from '@/utils/tools'
import { useI18n } from '@/lang'
import { useTheme } from '@/store/theme/hook'
import { useMusicFileSync } from '@/store/musicFileSync/hook'
import { applySync, cancel, compare } from '@/core/musicFileSync'
import { sizeFormate } from '@/utils'

export interface MusicFileSyncModalType {
  show: () => void
}

const GROUP_KEYS: LX.Sync.MusicFile.FileGroupKey[] = ['remoteAdded', 'localAdded']

const GROUP_TITLE_KEYS = {
  remoteAdded: 'setting_sync_music_file_group_remoteAdded',
  localAdded: 'setting_sync_music_file_group_localAdded',
} as const

const selectionKey = (item: LX.Sync.MusicFile.PlanItem) => `${item.group}:${item.path}`

export default forwardRef<MusicFileSyncModalType>((_props, ref) => {
  const t = useI18n()
  const theme = useTheme()
  const popupRef = useRef<PopupType>(null)
  const [visible, setVisible] = useState(false)
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const state = useMusicFileSync()
  const { plan, progress, busy, error, remoteRoot, remoteDeviceName } = state

  const initSelection = useCallback((groups: LX.Sync.MusicFile.PlanGroups) => {
    const nextChecked: Record<string, boolean> = {}
    for (const key of GROUP_KEYS) {
      for (const item of groups[key] ?? []) nextChecked[selectionKey(item)] = item.defaultChecked
    }
    setChecked(nextChecked)
  }, [])

  useImperativeHandle(ref, () => ({
    show() {
      if (visible) popupRef.current?.setVisible(true)
      else {
        setVisible(true)
        requestAnimationFrame(() => popupRef.current?.setVisible(true))
      }
    },
  }), [visible])

  const handleCompare = useCallback(() => {
    void compare().then(result => {
      if (result) initSelection(result.plan)
    })
  }, [initSelection])

  const handleApply = useCallback(() => {
    void applySync({ checked })
  }, [checked])

  const handleCancel = useCallback(() => {
    cancel()
  }, [])

  const setGroupChecked = useCallback((key: LX.Sync.MusicFile.FileGroupKey, check: boolean) => {
    setChecked(prev => {
      const next = { ...prev }
      for (const item of plan?.[key] ?? []) next[selectionKey(item)] = check
      return next
    })
  }, [plan])

  const groups = useMemo(() => {
    if (!plan) return []
    return GROUP_KEYS
      .map(key => ({ key, items: plan[key] ?? [] }))
      .filter(group => group.items.length > 0)
  }, [plan])

  const totalChanges = useMemo(() => GROUP_KEYS.reduce((sum, key) => sum + (plan?.[key]?.length ?? 0), 0), [plan])

  const progressPercent = progress.totalBytes ? Math.min(1, progress.doneBytes / progress.totalBytes) : 0
  const progressText = useMemo(() => {
    if (progress.stage === 'transferring') {
      return t('setting_sync_music_file_progress_transfer', { current: progress.actionIndex, total: progress.actionTotal, path: progress.path })
    }
    if (progress.stage === 'done') return t('setting_sync_music_file_progress_done')
    if (progress.stage === 'error') return progress.message || t('setting_sync_music_file_progress_error')
    return progress.message
  }, [progress, t])

  const content = useMemo(() => {
    return (
      <ScrollView style={styles.body} keyboardShouldPersistTaps="always">
        {error ? <Text style={styles.error} size={12} color={theme['c-500']}>{error}</Text> : null}
        {remoteRoot
          ? (
              <View style={styles.peerBox}>
                {remoteDeviceName ? <Text size={11} color={theme['c-font-label']}>{t('setting_sync_music_file_remote_device', { name: remoteDeviceName })}</Text> : null}
                <Text size={11} color={theme['c-font-label']}>{t('setting_sync_music_file_remote_root', { path: remoteRoot })}</Text>
              </View>
            )
          : null}
        {progress.running || progress.message
          ? (
              <View style={styles.progressBox}>
                <Text size={12} color={theme['c-font-label']}>{progressText}</Text>
                <View style={{ ...styles.progressTrack, backgroundColor: theme['c-primary-light-100-alpha-800'] }}>
                  <View style={{ ...styles.progressValue, width: `${Math.round(progressPercent * 100)}%`, backgroundColor: theme['c-primary'] }} />
                </View>
              </View>
            )
          : null}
        {plan
          ? (
              totalChanges
                ? (
                    <>
                      <Text style={styles.summary} size={12} color={theme['c-font-label']}>{t('setting_sync_music_file_plan_summary', { count: totalChanges })}</Text>
                      {groups.map(group => (
                        <View key={group.key} style={styles.group}>
                          <CheckBox
                            check={group.items.every(item => checked[selectionKey(item)])}
                            label={`${t(GROUP_TITLE_KEYS[group.key])} (${group.items.length})`}
                            onChange={check => { setGroupChecked(group.key, check) }}
                          />
                          {group.items.map(item => (
                            <View key={item.path} style={styles.item}>
                              <CheckBox
                                check={!!checked[selectionKey(item)]}
                                onChange={check => { setChecked(prev => ({ ...prev, [selectionKey(item)]: check })) }}
                              >
                                <View style={styles.itemText}>
                                  <Text size={12} numberOfLines={2}>{item.path}</Text>
                                  <Text size={11} color={theme['c-font-label']}>
                                    {[
                                      item.localSize != null ? `${t('setting_sync_music_file_local')} ${sizeFormate(item.localSize)}` : '',
                                      item.remoteSize != null ? `${t('setting_sync_music_file_remote')} ${sizeFormate(item.remoteSize)}` : '',
                                    ].filter(Boolean).join(' · ')}
                                  </Text>
                                </View>
                              </CheckBox>
                            </View>
                          ))}
                        </View>
                      ))}
                    </>
                  )
                : <Text style={styles.summary} size={13} color={theme['c-font-label']}>{t('setting_sync_music_file_plan_empty')}</Text>
            )
          : null}
      </ScrollView>
    )
  }, [error, remoteRoot, remoteDeviceName, progress.running, progress.message, progressText, progressPercent, plan, totalChanges, groups, checked, setGroupChecked, t, theme])

  return (
    visible
      ? (
          <Popup ref={popupRef} title={t('setting_sync_music_file')} onHide={() => { setVisible(false) }}>
            {content}
            <View style={styles.footer}>
              <Button disabled={busy || progress.running} onPress={handleCompare}>{t('setting_sync_music_file_compare')}</Button>
              <Button disabled={!plan || progress.running} onPress={handleApply}>{t('setting_sync_music_file_apply')}</Button>
              {progress.running ? <Button onPress={handleCancel}>{t('setting_sync_music_file_cancel')}</Button> : null}
            </View>
          </Popup>
        )
      : null
  )
})

const styles = createStyle({
  body: {
    flexGrow: 0,
    flexShrink: 1,
    maxHeight: 420,
    paddingLeft: 15,
    paddingRight: 15,
  },
  error: {
    marginBottom: 8,
  },
  peerBox: {
    marginBottom: 8,
  },
  progressBox: {
    marginBottom: 10,
  },
  progressTrack: {
    height: 5,
    borderRadius: 40,
    overflow: 'hidden',
    marginTop: 5,
  },
  progressValue: {
    height: '100%',
  },
  summary: {
    marginBottom: 8,
  },
  group: {
    marginBottom: 10,
  },
  item: {
    paddingLeft: 20,
    paddingTop: 4,
    paddingBottom: 4,
  },
  itemText: {
    flexShrink: 1,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingLeft: 15,
    paddingRight: 5,
    paddingBottom: 15,
    paddingTop: 10,
  },
})
