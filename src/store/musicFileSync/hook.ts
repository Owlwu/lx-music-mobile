import { useEffect, useState } from 'react'
import state, { type InitState } from './state'

export const useMusicFileSync = (): InitState => {
  const [value, update] = useState<InitState>({ ...state })

  useEffect(() => {
    global.state_event.on('musicFileSyncUpdated', update)
    return () => {
      global.state_event.off('musicFileSyncUpdated', update)
    }
  }, [])

  return value
}

export default useMusicFileSync
