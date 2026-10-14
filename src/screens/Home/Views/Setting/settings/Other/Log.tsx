import { memo, useRef, useState, useEffect } from 'react'
import { View } from 'react-native'
import { getLogs, clearLogs, getLogPath, flushLogs, getDiagnostics } from '@/utils/log'
import { clearLogFiles, readLogFile, runtimeLogPath } from '@/utils/runtimeLog'
// import { gzip, ungzip } from 'pako'

import SubTitle from '../../components/SubTitle'
import Button from '../../components/Button'
import { createStyle, toast, clipboardWriteText, confirmDialog } from '@/utils/tools'
import { shareText } from '@/utils/nativeModules/utils'
import ConfirmAlert, { type ConfirmAlertType } from '@/components/common/ConfirmAlert'
import CheckBoxItem from '../../components/CheckBoxItem'
import { useI18n } from '@/lang'
import Text from '@/components/common/Text'

// 与既有实现保持一致的旧日志切分规则（error.log 用 '----lx log----' 分隔）
const splitLegacyLog = (log: string) => {
  const logArr = log.split(/^----lx log----\n|\n----lx log----\n|\n----lx log----$/)
  logArr.reverse()
  return logArr.join('\n\n').replace(/^\n+|\n+$/, '')
}

export default memo(() => {
  const t = useI18n()
  const alertRef = useRef<ConfirmAlertType>(null)
  const [logText, setLogText] = useState('')
  const [logPath, setLogPath] = useState('')
  const [runtimePath, setRuntimePath] = useState('')
  const [isFetchingRuntimeLog, setIsFetchingRuntimeLog] = useState(false)
  // 当前弹窗里展示的是哪份日志：false=error.log，true=runtime.log。
  // 「清空」按钮据此决定删哪一份，避免"看着 runtime.log、却把 error.log 删了"。
  const [isShowingRuntimeLog, setIsShowingRuntimeLog] = useState(false)
  const isUnmountedRef = useRef(true)
  const [isEnableSyncErrorLog, setIsEnableSyncErrorLog] = useState(global.lx.isEnableSyncLog)
  const [isEnableUserApiLog, setIsEnableUserApiLog] = useState(global.lx.isEnableUserApiLog)

  // 刷新展示用的磁盘路径（可能返回 ''，表示当前平台目录还不可用）
  const refreshPaths = () => {
    setLogPath(getLogPath())
    setRuntimePath(runtimeLogPath())
  }

  const getErrorLog = () => {
    refreshPaths()
    void getLogs().then(log => {
      if (isUnmountedRef.current) return
      setLogText(splitLegacyLog(log))
    })
  }

  const openLogModal = () => {
    // 标记当前弹窗展示的是 error.log，保证弹窗里的「清空」清的就是这份日志
    setIsShowingRuntimeLog(false)
    getErrorLog()
    alertRef.current?.setVisible(true)
  }

  const handleCleanLog = () => {
    void clearLogs().then(() => {
      if (isUnmountedRef.current) return
      toast(t('setting_other_log_tip_clean_success'))
      getErrorLog()
    })
  }

  // 弹窗里的「清空」：清掉的一定是当前正在展示的那份日志。
  // 展示 error.log 时清 error.log；展示 runtime.log 时清 runtime.log（含备份）。
  const handleCleanShowingLog = () => {
    if (!isShowingRuntimeLog) {
      handleCleanLog()
      return
    }
    void confirmDialog({
      message: t('setting_other_log_clean_file_confirm'),
      confirmButtonText: t('setting_other_log_btn_clean'),
    }).then(confirm => {
      if (!confirm) return
      void clearLogFiles().then(() => {
        if (isUnmountedRef.current) return
        toast(t('setting_other_log_tip_clean_success'))
        setLogText('')
      })
    })
  }

  // 查看运行时日志（落盘文件全文 + 备份）。先 flush 保证包含刚刚产生的日志。
  const handleShowRuntimeLog = () => {
    if (isFetchingRuntimeLog) return
    setIsFetchingRuntimeLog(true)
    void flushLogs().then(async() => readLogFile()).then(text => {
      if (isUnmountedRef.current) return
      setIsShowingRuntimeLog(true)
      refreshPaths()
      setLogText(text ? text.replace(/^\n+|\n+$/, '') : '')
      alertRef.current?.setVisible(true)
    }).catch(() => {
      if (isUnmountedRef.current) return
      // 读日志失败时不能让用户"点了没反应"，给出明确提示
      toast(t('setting_other_log_tip_read_failed'))
    }).finally(() => {
      if (isUnmountedRef.current) return
      setIsFetchingRuntimeLog(false)
    })
  }

  // 诊断信息 = 运行时日志状态 + 最近日志 + error.log 路径，供反馈问题时整段复制
  const handleCopyDiagnostics = () => {
    void flushLogs().then(() => {
      if (isUnmountedRef.current) return
      const text = [
        getDiagnostics(),
        '',
        `error.log: ${getLogPath() || '[unavailable]'}`,
      ].join('\n')
      clipboardWriteText(text)
      toast(t('copy_name_tip'))
    })
  }

  const handleShareLog = () => {
    void flushLogs().then(async() => readLogFile()).then(text => {
      if (isUnmountedRef.current) return
      if (!text) {
        toast(t('setting_other_log_tip_null'))
        return
      }
      const content = `${t('setting_other_log_share_desc')}\n${runtimeLogPath()}\n\n${text.replace(/^\n+|\n+$/, '')}`
      void shareText(t('setting_other_log_share_title'), t('setting_other_log_share_title'), content)
    })
  }

  // 破坏性操作：删除运行时日志文件，先二次确认（用户可能想保留证据）
  const handleCleanLogFiles = () => {
    void confirmDialog({
      message: t('setting_other_log_clean_file_confirm'),
      confirmButtonText: t('setting_other_log_btn_clean'),
    }).then(confirm => {
      if (!confirm) return
      void clearLogFiles().then(() => {
        if (isUnmountedRef.current) return
        toast(t('setting_other_log_tip_clean_success'))
        // 运行时日志已被清空，弹窗里若正展示它也要一并复位
        if (isShowingRuntimeLog) setLogText('')
      })
    })
  }

  const handleSetEnableSyncErrorLog = (enable: boolean) => {
    setIsEnableSyncErrorLog(enable)
    global.lx.isEnableSyncLog = enable
  }

  const handleSetEnableUserApiLog = (enable: boolean) => {
    setIsEnableUserApiLog(enable)
    global.lx.isEnableUserApiLog = enable
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
          <CheckBoxItem check={isEnableUserApiLog} label={t('setting_other_log_user_api_log')} onChange={handleSetEnableUserApiLog} />
        </View>
        <View style={styles.pathText}>
          <Text size={12}>{t('setting_other_log_path')}{logPath || t('setting_other_log_path_unavailable')}</Text>
          <Text size={12} selectable>{t('setting_other_log_runtime_path')}{runtimePath || t('setting_other_log_path_unavailable')}</Text>
        </View>
        <View style={styles.btn}>
          <Button onPress={openLogModal}>{t('setting_other_log_btn_show')}</Button>
          <Button disabled={isFetchingRuntimeLog} onPress={handleShowRuntimeLog}>{t('setting_other_log_btn_show_runtime')}</Button>
        </View>
        <View style={styles.btn}>
          <Button onPress={handleShareLog}>{t('setting_other_log_btn_share')}</Button>
          <Button onPress={handleCopyDiagnostics}>{t('setting_other_log_btn_copy_diagnostics')}</Button>
          <Button onPress={handleCleanLogFiles}>{t('setting_other_log_btn_clean_file')}</Button>
        </View>
      </SubTitle>
      <ConfirmAlert
        ref={alertRef}
        cancelText={t('setting_other_log_btn_hide')}
        confirmText={t('setting_other_log_btn_clean')}
        onConfirm={handleCleanShowingLog}
        showConfirm={!!logText}
        reverseBtn={true}
        >
        <View onStartShouldSetResponder={() => true}>
          {
            logText
              ? <Text selectable size={13}>{ logText }</Text>
              : <Text size={13}>{t('setting_other_log_tip_null')}</Text>
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
