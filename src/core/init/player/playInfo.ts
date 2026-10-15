import { getPlayInfo } from '@/utils/data'
import { getListMusics } from '@/core/list'
import { playList, play } from '@/core/player/player'
import { info, warn } from '@/utils/runtimeLog'
import { markEvent } from '@/utils/stallWatchdog'


export default async(setting: LX.AppSetting) => {
  const info_ = await getPlayInfo()
  global.lx.restorePlayInfo = null
  if (!info_?.listId || info_.index < 0) {
    info('BOOT', 'restore play info skipped (no saved play info)', { listId: info_?.listId ?? '', index: info_?.index ?? -1 })
    return
  }

  // 恢复播放会 await playList() → handlePlay()：启动路径上最容易卡住的一段（原实现零日志）
  info('BOOT', 'restore play info start', { listId: info_.listId, index: info_.index })
  markEvent('boot:restorePlayInfo', { listId: info_.listId, index: info_.index })
  const list = await getListMusics(info_.listId)
  if (!list[info_.index]) {
    warn('BOOT', 'restore play info skipped (index out of range)', { listId: info_.listId, index: info_.index, listLen: list.length })
    return
  }
  global.lx.restorePlayInfo = info_

  await playList(info_.listId, info_.index)
  info('BOOT', 'restore play info done', {
    listId: info_.listId,
    index: info_.index,
    isTempPlay: global.lx.restorePlayInfo == null,
  })

  if (setting['player.startupAutoPlay']) {
    info('BOOT', 'restore play info: startupAutoPlay scheduled')
    setTimeout(play)
  }


  // if (!info.list || !info.list[info.index]) {
  //   const info2 = { ...info }
  //   if (info2.list) {
  //     info2.music = info2.list[info2.index]?.name
  //     info2.list = info2.list.length
  //   }
  //   toast('恢复播放数据失败，请去错误日志查看', 'long')
  //   log.warn('Restore Play Info failed: ', JSON.stringify(info2, null, 2))

  //   return
  // }

  // let setting = store.getState().common.setting
  // global.restorePlayInfo = {
  //   info,
  //   startupAutoPlay: setting.startupAutoPlay,
  // }

  // store.dispatch(playerAction.setList({
  //   list: {
  //     list: info.list,
  //     id: info.listId,
  //   },
  //   index: info.index,
  // }))
}
