import { connectServer } from '@/plugins/sync'
import { updateSetting } from '@/core/common'
import { getSyncHost } from '@/plugins/sync/data'
import log from '@/plugins/sync/log'


export default async(setting: LX.AppSetting) => {
  if (!setting['sync.enable']) return

  let host: string
  try {
    host = await getSyncHost()
  } catch (err: any) {
    // 本函数由启动链路以 void 调用，任何 rejection 都会变成 RN 的
    // unhandled promise rejection（LogBox 报错通知），因此读设置失败也只记录不外抛。
    log.r_error('get sync host failed:', err?.message ?? String(err))
    return
  }
  // console.log(host)
  if (!host) {
    updateSetting({ 'sync.enable': false })
    return
  }
  // connectServer 失败时会 reject（与桌面端 sync client 同一份实现），这里必须显式 catch：
  // 否则 RN 会把它记为 unhandled promise rejection，并在界面上弹出
  // 「Possible unhandled promise rejection: Error: Connect service failed」的 LogBox 通知。
  // hello 请求最长 10s 才超时，所以这个通知通常刚好在用户已经开始听歌时才弹出来。
  // 失败原因已由 connectServer 内部写入同步状态（设置 → 同步 的状态文本可见），此处只补日志。
  void connectServer(host).catch((err: Error) => {
    log.warn('auto connect failed:', err.message)
  })
}
