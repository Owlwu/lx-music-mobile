import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { ScrollView, View } from 'react-native'

import Popup, { type PopupType } from '@/components/common/Popup'
import CheckBox from '@/components/common/CheckBox'
import Text from '@/components/common/Text'
import Button from '../../components/Button'
import { createStyle, toast } from '@/utils/tools'
import { useI18n } from '@/lang'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import { getFolders } from '@/core/musicFileSync'
import { useTheme } from '@/store/theme/hook'

export interface MusicFileScopeModalType {
  show: () => void
}

interface FlatFolder extends LX.Sync.MusicFile.FolderNode {
  depth: number
}

const flatten = (nodes: LX.Sync.MusicFile.FolderNode[], depth = 0): FlatFolder[] => {
  const list: FlatFolder[] = []
  for (const node of nodes) {
    list.push({ ...node, depth })
    list.push(...flatten(node.children ?? [], depth + 1))
  }
  return list
}

export default forwardRef<MusicFileScopeModalType>((_props, ref) => {
  const t = useI18n()
  const theme = useTheme()
  const popupRef = useRef<PopupType>(null)
  const [visible, setVisible] = useState(false)
  const [folders, setFolders] = useState<FlatFolder[]>([])
  const [scope, setScope] = useState<string[]>([])
  const settingScope = useSettingValue('sync.musicFile.scope')

  const handleShow = useCallback(() => {
    setScope([...settingScope])
    popupRef.current?.setVisible(true)
    void getFolders().then(list => {
      setFolders(flatten(list))
    }).catch((err: unknown) => {
      toast(String((err as Error)?.message ?? err), 'long')
      setFolders([])
    })
  }, [settingScope])

  useImperativeHandle(ref, () => ({
    show() {
      if (visible) handleShow()
      else {
        setVisible(true)
        requestAnimationFrame(handleShow)
      }
    },
  }), [visible, handleShow])

  // 已被祖先文件夹覆盖的条目由祖先代表，显示为选中且不可单独取消
  const isImplied = useCallback((path: string) => {
    return scope.some(parent => parent !== path && path.startsWith(parent + '/'))
  }, [scope])

  const handleToggle = useCallback((folder: FlatFolder, check: boolean) => {
    if (isImplied(folder.path)) return
    let newScope = [...scope]
    const index = newScope.indexOf(folder.path)
    if (check && index === -1) newScope.push(folder.path)
    else if (!check && index > -1) newScope.splice(index, 1)
    setScope(newScope)
    updateSetting({ 'sync.musicFile.scope': newScope })
  }, [scope, isImplied])

  const handleClear = useCallback(() => {
    setScope([])
    updateSetting({ 'sync.musicFile.scope': [] })
  }, [])

  const content = useMemo(() => {
    if (!folders.length) {
      return <Text style={styles.empty} size={13} color={theme['c-font-label']}>{t('setting_sync_music_file_scope_empty')}</Text>
    }
    return (
      <ScrollView style={styles.list} keyboardShouldPersistTaps="always">
        {folders.map(folder => (
          <View key={folder.path} style={{ ...styles.item, paddingLeft: 15 + folder.depth * 18 }}>
            <CheckBox
              check={isImplied(folder.path) || scope.includes(folder.path)}
              disabled={isImplied(folder.path)}
              label={`${folder.name} (${folder.totalCount})`}
              onChange={check => { handleToggle(folder, check) }}
            />
          </View>
        ))}
      </ScrollView>
    )
  }, [folders, scope, isImplied, handleToggle, t, theme])

  return (
    visible
      ? (
          <Popup ref={popupRef} title={t('setting_sync_music_file_scope_title')} onHide={() => { setVisible(false) }}>
            <Text style={styles.tip} size={12} color={theme['c-font-label']}>{t('setting_sync_music_file_scope_tip')}</Text>
            {content}
            <View style={styles.footer}>
              <Button onPress={handleClear}>{t('setting_sync_music_file_scope_clear')}</Button>
              <Button onPress={() => { popupRef.current?.setVisible(false) }}>{t('setting_sync_music_file_scope_done')}</Button>
            </View>
          </Popup>
        )
      : null
  )
})

const styles = createStyle({
  tip: {
    paddingLeft: 15,
    paddingRight: 15,
    paddingBottom: 8,
  },
  list: {
    flexGrow: 0,
    flexShrink: 1,
    maxHeight: 380,
  },
  item: {
    paddingTop: 6,
    paddingBottom: 6,
    paddingRight: 15,
  },
  empty: {
    padding: 20,
    textAlign: 'center',
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
