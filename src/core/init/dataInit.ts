// import { getPlayInfo } from '@/utils/data'
// import { log } from '@/utils/log'
import { init as musicSdkInit } from '@/utils/musicSdk'
import { getUserLists, setUserList } from '@/core/list'
import { setNavActiveId } from '../common'
import { getViewPrevState } from '@/utils/data'
import { bootLog } from '@/utils/bootLog'
import { getDislikeInfo, setDislikeInfo } from '@/core/dislikeList'
import { unlink } from '@/utils/fs'
import { TEMP_FILE_PATH } from '@/utils/tools'
import { info, error as logError } from '@/utils/runtimeLog'
import { markEvent } from '@/utils/stallWatchdog'
// import { play, playList } from '../player/player'

// const initPrevPlayInfo = async(appSetting: LX.AppSetting) => {
//   const info = await getPlayInfo()
//   global.lx.restorePlayInfo = null
//   if (!info?.listId || info.index < 0) return
//   const list = await getListMusics(info.listId)
//   if (!list[info.index]) return
//   global.lx.restorePlayInfo = info
//   await playList(info.listId, info.index)

//   if (appSetting['player.startupAutoPlay']) setTimeout(play)
// }

export default async(appSetting: LX.AppSetting) => {
  // await Promise.all([
  //   initUserApi(), // 自定义API
  // ]).catch(err => log.error(err))
  const dataInitTime = Date.now()
  markEvent('boot:dataInitStart')
  info('BOOT', 'dataInit: start')
  void musicSdkInit() // 初始化音乐sdk
  bootLog('User list init...')
  markEvent('boot:dataInit:getUserLists')
  // 这一步依赖存储读取，是"应用打开后空白"最常见的卡点之一：
  // 即使失败也要留下落盘日志，否则白屏时没有任何现场证据
  setUserList(await getUserLists().catch((err) => {
    logError('BOOT', 'dataInit: getUserLists failed', { error: err?.stack ?? err?.message ?? String(err) })
    throw err
  })) // 获取用户列表
  bootLog('User list loaded.')
  markEvent('boot:dataInit:getDislikeInfo')
  setDislikeInfo(await getDislikeInfo().catch((err) => {
    logError('BOOT', 'dataInit: getDislikeInfo failed', { error: err?.stack ?? err?.message ?? String(err) })
    throw err
  })) // 获取不喜欢列表
  bootLog('User list inited.')
  markEvent('boot:dataInit:getViewPrevState')
  setNavActiveId((await getViewPrevState()).id)
  bootLog('View prev state inited.')
  void unlink(TEMP_FILE_PATH)
  info('BOOT', 'dataInit: done', { costMs: Date.now() - dataInitTime })
  markEvent('boot:dataInitDone', { costMs: Date.now() - dataInitTime })
  // await initPrevPlayInfo(appSetting).catch(err => log.error(err)) // 初始化上次的歌曲播放信息
}
