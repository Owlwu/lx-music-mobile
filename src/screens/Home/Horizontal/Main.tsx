import { useEffect, useMemo, useState } from 'react'
import Mylist from '../Views/Mylist'
import Setting from '../Views/Setting'
import commonState, { type InitState as CommonState } from '@/store/common/state'


const Main = () => {
  const [id, setId] = useState(commonState.navActiveId)

  useEffect(() => {
    const handleUpdate = (id: CommonState['navActiveId']) => {
      requestAnimationFrame(() => {
        setId(id)
      })
    }
    global.state_event.on('navActiveIdUpdated', handleUpdate)
    return () => {
      global.state_event.off('navActiveIdUpdated', handleUpdate)
    }
  }, [])

  const component = useMemo(() => {
    switch (id) {
      case 'nav_setting': return <Setting />
      case 'nav_love':
      default: return <Mylist />
    }
  }, [id])

  return component
}


export default Main
