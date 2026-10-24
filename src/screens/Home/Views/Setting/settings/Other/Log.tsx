import { memo, useRef, useState, useEffect } from 'react'
import { View } from 'react-native'
import { clearLogFiles, runtimeLogPath } from '@/utils/runtimeLog'
import { readImportLog, clearImportLogFile, importLogPath } from '@/utils/importLog'
import {
  buildFullDiagnostics,
  writeFullDiagnosticsToFile,
  clipboardBudget,
  maxClipboardChars,
  clipText,
} from '@/utils/diagnostics'

import SubTitle from '../../components/SubTitle'
import Button from '../../components/Button'
import { createStyle, toast, confirmDialog } from '@/utils/tools'
import { shareText, shareFile } from '@/utils/nativeModules/utils'
import ConfirmAlert, { type ConfirmAlertType } from '@/components/common/ConfirmAlert'
import CheckBoxItem from '../../components/CheckBoxItem'
import { useI18n } from '@/lang'
import Text from '@/components/common/Text'

/**
 * 日志设置
 *
 * 只保留三个按钮，各自职责互不重叠：
 * - 「查看日志」：本地歌曲导入失败的记录（`import.log`），只出导入相关问题；
 * - 「分享日志」：程序运行日志（`runtime.log` + 原生日志 + 事件流水账 + 即时状态），导出成
 *   文件分享出去，用于反馈 bug；
 * - 「清空日志文件」：清空上面两类日志的全部文件与备份。
 *
 * 曾经的「查看运行时日志」与「复制诊断信息」都已删除：前者只是把「分享日志」里已经包含的
 * runtime.log 尾部渲染到屏幕上，后者是把同一份诊断内容塞进剪贴板（还要截断），
 * 三者实质是同一份数据，保留一个「分享日志」即可覆盖排查需求。
 */
export default memo(() => {
  const t = useI18n()
  const alertRef = useRef<ConfirmAlertType>(null)
  const [logText, setLogText] = useState('')
  const [importPath, setImportPath] = useState('')
  const [runtimePath, setRuntimePath] = useState('')
  const isUnmountedRef = useRef(true)
  const [isEnableSyncErrorLog, setIsEnableSyncErrorLog] = useState(global.lx.isEnableSyncLog)

  // 刷新展示用的磁盘路径（可能返回 ''，表示当前平台目录还不可用）
  const refreshPaths = () => {
    setImportPath(importLogPath())
    setRuntimePath(runtimeLogPath())
  }

  const loadImportLog = async() => {
    const text = await readImportLog()
    if (isUnmountedRef.current) return
    setLogText(text.replace(/^\n+|\n+$/g, ''))
  }

  const openImportLogModal = () => {
    refreshPaths()
    void loadImportLog().then(() => {
      if (isUnmountedRef.current) return
      alertRef.current?.setVisible(true)
    }).catch(() => {
      if (isUnmountedRef.current) return
      toast(t('setting_other_log_tip_read_failed'))
    })
  }

  // 弹窗里的「清空」：只清导入日志（运行日志走下面的「清空日志文件」）
  const handleCleanImportLog = () => {
    void confirmDialog({
      message: t('setting_other_log_clean_import_confirm'),
      confirmButtonText: t('setting_other_log_btn_clean'),
    }).then(confirm => {
      if (!confirm) return
      void clearImportLogFile().then(async() => {
        if (isUnmountedRef.current) return
        toast(t('setting_other_log_tip_clean_success'))
        await loadImportLog()
      })
    })
  }

  // 「分享日志」：改为**文件分享**，这是修复"点分享日志直接把应用打死"的关键。
  // 原实现把整份日志塞进 Intent.EXTRA_TEXT，而 Binder 事务有大小上限：
  // 日志变大后 startActivity 抛出的异常无人接管，被全局异常处理器接管界面 ——
  // 用户看到 "Critical Error Occured !"、界面被 finish，只能杀进程重开。
  // 文件走 FileProvider（content://），不经过 Binder，因此没有大小限制。
  const handleShareLog = () => {
    void writeFullDiagnosticsToFile()
      .then(async({ path }) => {
        if (isUnmountedRef.current) return
        try {
          await shareFile(t('setting_other_log_share_title'), t('setting_other_log_share_title'), path, 'text/plain')
          return
        } catch (err) {
          // 文件分享不可用（例如设备上没有可接收的应用）：退化为受限长度的文本分享
        }
        if (isUnmountedRef.current) return
        const fallback = clipText(await buildFullDiagnostics(clipboardBudget), maxClipboardChars)
        await shareText(
          t('setting_other_log_share_title'),
          t('setting_other_log_share_title'),
          `${t('setting_other_log_share_desc')}\n${path}\n\n${fallback}`,
        )
        toast(t('setting_other_log_tip_truncated'))
      })
      .catch(() => {
        if (isUnmountedRef.current) return
        toast(t('setting_other_log_tip_share_failed'))
      })
  }

  // 破坏性操作：删除日志文件，先二次确认（用户可能想保留证据）
  const handleCleanLogFiles = () => {
    void confirmDialog({
      message: t('setting_other_log_clean_file_confirm'),
      confirmButtonText: t('setting_other_log_btn_clean'),
    }).then(confirm => {
      if (!confirm) return
      void Promise.all([clearLogFiles(), clearImportLogFile()]).then(() => {
        if (isUnmountedRef.current) return
        toast(t('setting_other_log_tip_clean_success'))
        // 弹窗里展示的导入日志也被清空了，一并复位
        setLogText('')
        refreshPaths()
      })
    })
  }

  const handleSetEnableSyncErrorLog = (enable: boolean) => {
    setIsEnableSyncErrorLog(enable)
    global.lx.isEnableSyncLog = enable
  }

  useEffect(() => {
    isUnmountedRef.current = false
    refreshPaths()
    return () => {
      isUnmountedRef.current = true
    }
  }, [])

  return (
    <>
      <SubTitle title={t('setting_other_log')}>
        <View style={styles.checkBox}>
          <CheckBoxItem check={isEnableSyncErrorLog} label={t('setting_other_log_sync_log')} onChange={handleSetEnableSyncErrorLog} />
        </View>
        <View style={styles.pathText}>
          <Text size={12}>{t('setting_other_log_import_path')}{importPath || t('setting_other_log_path_unavailable')}</Text>
          <Text size={12} selectable>{t('setting_other_log_runtime_path')}{runtimePath || t('setting_other_log_path_unavailable')}</Text>
        </View>
        <View style={styles.btn}>
          <Button onPress={openImportLogModal}>{t('setting_other_log_btn_show')}</Button>
          <Button onPress={handleShareLog}>{t('setting_other_log_btn_share')}</Button>
          <Button onPress={handleCleanLogFiles}>{t('setting_other_log_btn_clean_file')}</Button>
        </View>
      </SubTitle>
      <ConfirmAlert
        ref={alertRef}
        cancelText={t('setting_other_log_btn_hide')}
        confirmText={t('setting_other_log_btn_clean')}
        onConfirm={handleCleanImportLog}
        showConfirm={!!logText}
        reverseBtn={true}
        >
        <View onStartShouldSetResponder={() => true}>
          {
            logText
              ? <Text selectable size={13}>{ logText }</Text>
              : <Text size={13}>{t('setting_other_log_import_empty')}</Text>
          }
        </View>
      </ConfirmAlert>
    </>
  )
})

const styles = createStyle({
  checkBox: {
    // paddingTop: 10,
    paddingBottom: 15,
    marginLeft: -25,
  },
  pathText: {
    marginBottom: 15,
    marginLeft: -10,
  },
  btn: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 5,
    marginBottom: 5,
  },
})
