import { isActive } from '@/utils/tools'
import { AppState } from 'react-native'
import { useEffect, useState } from 'react'
import state, { type InitState } from './state'
import { info } from '@/utils/runtimeLog'

export const usePlayerMusicInfo = () => {
  const [value, update] = useState(state.musicInfo)

  useEffect(() => {
    global.state_event.on('playerMusicInfoChanged', update)
    return () => {
      global.state_event.off('playerMusicInfoChanged', update)
    }
  }, [])

  return value
}

export const usePlayMusicInfo = () => {
  const [value, update] = useState(state.playMusicInfo)

  useEffect(() => {
    global.state_event.on('playMusicInfoChanged', update)
    return () => {
      global.state_event.off('playMusicInfoChanged', update)
    }
  }, [])

  return value
}

export const usePlayInfo = () => {
  const [value, update] = useState(state.playInfo)

  useEffect(() => {
    global.state_event.on('playInfoChanged', update)
    return () => {
      global.state_event.off('playInfoChanged', update)
    }
  }, [])

  return value
}

export const useStatusText = () => {
  const [value, update] = useState(state.statusText)

  useEffect(() => {
    global.state_event.on('playStateTextChanged', update)
    return () => {
      global.state_event.off('playStateTextChanged', update)
    }
  }, [])

  return value
}

export const useIsPlay = () => {
  const [value, update] = useState(state.isPlay)

  useEffect(() => {
    global.state_event.on('playStateChanged', update)
    return () => {
      global.state_event.off('playStateChanged', update)
    }
  }, [])

  return value
}

/**
 * 渲染存活标记的节流间隔（毫秒）。
 * 这条日志是"React 树是否还在更新"的唯一直接证据：
 * 心跳仍在（JS 活着）但这里长时间没有输出 ⇒ 界面已经不渲染了（用户看到的"空白"）。
 */
const renderLogInterval = 5000
let lastRenderLogAt = 0

export const useProgress = (autoUpdate = true) => {
  const [value, update] = useState(state.progress)

  useEffect(() => {
    if (!autoUpdate) return
    const handleUpdate = (progress: InitState['progress']) => {
      if (isActive()) {
        const now = Date.now()
        if (state.isPlay && now - lastRenderLogAt >= renderLogInterval) {
          lastRenderLogAt = now
          info('RENDER', 'progress rendered', {
            nowPlayTime: Math.round(progress.nowPlayTime),
            maxPlayTime: Math.round(progress.maxPlayTime),
            appState: AppState.currentState,
            trackId: global.lx.playerTrackId || '',
          })
        }
        update(progress)
      }
    }
    update(state.progress)
    global.state_event.on('playProgressChanged', handleUpdate)
    return () => {
      global.state_event.off('playProgressChanged', handleUpdate)
    }
  }, [autoUpdate])

  return value
}
