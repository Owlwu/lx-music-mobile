import { initSetting, showPactModal } from '@/core/common'
import registerPlaybackService from '@/plugins/player/service'
import initTheme from './theme'
import initI18n from './i18n'
import initPlayer from './player'
import dataInit from './dataInit'
import initSync from './sync'
import initCommonState from './common'
import { initDeeplink } from './deeplink'
import commonActions from '@/store/common/action'
import settingState from '@/store/setting/state'
import { bootLog } from '@/utils/bootLog'
import { cheatTip } from '@/utils/tools'
import { info, error as logError, flush } from '@/utils/runtimeLog'
import { markEvent } from '@/utils/stallWatchdog'

let isFirstPush = true
const handlePushedHomeScreen = async() => {
  bootLog('Pushed home screen handling...')
  markEvent('boot:handlePushedHomeScreen')
  try {
    await cheatTip()
    bootLog('Cheat tip handled.')
  } catch (err: any) {
    // 只记录，不改变原有行为（吞掉异常继续走后面的分支）
    logError('BOOT', 'cheatTip failed', { error: err?.stack ?? err?.message ?? String(err) })
    throw err
  }
  if (settingState.setting['common.isAgreePact']) {
    if (isFirstPush) {
      isFirstPush = false
      void initDeeplink()
      bootLog('Update check & deeplink inited.')
    }
  } else {
    if (isFirstPush) isFirstPush = false
    showPactModal()
    bootLog('Pact modal shown.')
  }
  info('BOOT', 'handlePushedHomeScreen done')
  void flush()
}

/** 启动阶段耗时统计：定位"打开后空白"卡在哪一步 */
const bootTime = Date.now()
const bootStep = (step: string) => {
  info('BOOT', `init step: ${step}`, { costMs: Date.now() - bootTime })
}

let isInited = false
export default async() => {
  if (isInited) {
    info('BOOT', 'init called but already inited, skip')
    return handlePushedHomeScreen
  }
  bootLog('Initing...')
  markEvent('boot:initStart')
  commonActions.setFontSize(global.lx.fontSize)
  bootLog('Font size changed.')
  bootStep('fontSize')
  const setting = await initSetting()
  bootLog('Setting inited.')
  bootStep('setting')
  // console.log(setting)

  await initTheme(setting)
  bootLog('Theme inited.')
  bootStep('theme')
  await initI18n(setting)
  bootLog('I18n inited.')
  bootStep('i18n')

  registerPlaybackService()
  bootLog('Playback Service Registered.')
  bootStep('registerPlaybackService')
  await initPlayer(setting)
  bootLog('Player inited.')
  bootStep('player')
  await dataInit(setting)
  bootLog('Data inited.')
  bootStep('dataInit')
  await initCommonState(setting)
  bootLog('Common State inited.')
  bootStep('commonState')

  void initSync(setting)
  bootLog('Sync inited.')
  bootStep('sync')

  // syncSetting()

  isInited ||= true

  info('BOOT', 'init done', { totalCostMs: Date.now() - bootTime })
  markEvent('boot:initDone', { totalCostMs: Date.now() - bootTime })
  // 初始化完成前若进程被杀/卡死，落盘日志是唯一的现场证据
  await flush()

  return handlePushedHomeScreen
}
