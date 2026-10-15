import { memo, useRef, useState, useEffect } from 'react'
import { View } from 'react-native'
import { getLogs, clearLogs, getLogPath, flushLogs } from '@/utils/log'
import { clearLogFiles, readLogFile, runtimeLogPath } from '@/utils/runtimeLog'
import {
  buildFullDiagnostics,
  writeFullDiagnosticsToFile,
  clipboardBudget,
  maxClipboardChars,
  clipText,
  tailClip,
} from '@/utils/diagnostics'
// import { gzip, ungzip } from 'pako'

import SubTitle from '../../components/SubTitle'
import Button from '../../components/Button'
import { createStyle, toast, clipboardWriteText, confirmDialog } from '@/utils/tools'
import { shareText, shareFile } from '@/utils/nativeModules/utils'
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

/** 「查看运行时日志」弹窗最多渲染多少字符：日志最大可达 1.5MB，全量渲染会让界面明显卡顿 */
const maxRuntimeLogViewChars = 200000

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
  // 显示层做长度裁剪：日志可达 1.5MB，直接塞进 <Text> 会让界面明显卡顿；
  // 完整内容请用「分享日志」（文件方式）。
  const handleShowRuntimeLog = () => {
    if (isFetchingRuntimeLog) return
    setIsFetchingRuntimeLog(true)
    void flushLogs().then(async() => readLogFile()).then(text => {
      if (isUnmountedRef.current) return
      setIsShowingRuntimeLog(true)
      refreshPaths()
      setLogText(text ? tailClip(text.replace(/^\n+|\n+$/g, ''), maxRuntimeLogViewChars) : '')
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

  // 诊断信息 = 即时状态 + 内存缓冲 + **落盘日志（跨多次启动）** + 原生侧日志。
  //
  // 注意这里不再使用旧的 getDiagnostics()：旧实现只导出"当前进程内存缓冲"，
  // 而用户遇到问题时习惯先重启应用，于是故障那一次进程的记录完全丢失，
  // 导出的日志里只剩重启后的几行启动日志（这正是之前三份日志无法排查的原因）。
  //
  // 同时必须限制导出体积：剪贴板同样有大小上限，超大文本还会拖慢系统。
  // 完整日志请点「分享日志」（文件方式，不受大小限制）。
  const handleCopyDiagnostics = () => {
    void flushLogs()
      .then(async() => buildFullDiagnostics(clipboardBudget))
      .then((text) => {
        if (isUnmountedRef.current) return
        const clipped = clipText(text, maxClipboardChars)
        try {
          clipboardWriteText(clipped)
        } catch (err) {
          toast(t('setting_other_log_tip_read_failed'))
          return
        }
        toast(clipped.length < text.length ? t('setting_other_log_tip_truncated') : t('copy_name_tip'))
      })
      .catch(() => {
        if (isUnmountedRef.current) return
        toast(t('setting_other_log_tip_read_failed'))
      })
  }

  // 「分享日志」：改为**文件分享**，这是修复"点分享日志直接把应用打死"的关键。
  // 原实现把整份日志（主文件 + 2 个轮转备份，最大约 1.5MB）塞进 Intent.EXTRA_TEXT，
  // 而 Binder 事务有大小上限：日志变大后 startActivity 抛出的异常无人接管，
  // 被 react-native-exception-handler 的全局处理器接管界面 —— 用户看到
  // "Critical Error Occured !"、界面被 finish，只能杀进程重开。
  // 文件走 FileProvider（content://），不经过 Binder，因此没有大小限制。
  const handleShareLog = () => {
    void flushLogs()
      .then(async() => writeFullDiagnosticsToFile())
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
