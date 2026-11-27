import { useRef, useImperativeHandle, forwardRef, useEffect } from 'react'
import SearchTipList, { type SearchTipListProps as _SearchTipListProps, type SearchTipListType } from '@/components/SearchTipList'
import { debounce } from '@/utils'
import { searchListMusic } from './listAction'
import Button from '@/components/common/Button'
import { createStyle } from '@/utils/tools'
import Text from '@/components/common/Text'
import { useI18n } from '@/lang'
import { useTheme } from '@/store/theme/hook'
import { View } from 'react-native'
import { scaleSizeH } from '@/utils/pixelRatio'
import { getListMusics } from '@/core/list'
import listState from '@/store/list/state'

type SearchTipListProps = _SearchTipListProps<LX.Music.MusicInfo>
interface ListMusicSearchProps {
  onScrollToInfo: (info: LX.Music.MusicInfo) => void
}
export const ITEM_HEIGHT = scaleSizeH(46)

export interface ListMusicSearchType {
  search: (keyword: string, height: number) => void
  hide: () => void
}

export const debounceSearchList = debounce((text: string, list: LX.List.ListMusics, callback: (list: LX.List.ListMusics) => void) => {
  // console.log(reslutList)
  callback(searchListMusic(list, text))
}, 200)


export default forwardRef<ListMusicSearchType, ListMusicSearchProps>(({ onScrollToInfo }, ref) => {
  const searchTipListRef = useRef<SearchTipListType<LX.Music.MusicInfo>>(null)
  const searchRequest = useRef(0)
  const currentKeywordRef = useRef('')
  const theme = useTheme()
  const t = useI18n()

  const search = (id: string, keyword: string) => {
    const request = ++searchRequest.current
    if (!keyword) {
      searchTipListRef.current?.setList([])
      return
    }
    void getListMusics(id).then(list => {
      if (request !== searchRequest.current) return
      debounceSearchList(keyword, list, (matches) => {
        if (request !== searchRequest.current) return
        searchTipListRef.current?.setList(matches, true)
      })
    })
  }

  const handleShowList = (keyword: string, height: number) => {
    searchTipListRef.current?.setHeight(height)
    currentKeywordRef.current = keyword
    search(listState.activeListId, keyword)
  }

  const invalidateSearch = () => { searchRequest.current++ }

  const dismissResults = () => {
    invalidateSearch()
    searchTipListRef.current?.setList([])
  }

  useImperativeHandle(ref, () => ({
    search(keyword, height) {
      handleShowList(keyword, height)
    },
    hide() {
      currentKeywordRef.current = ''
      dismissResults()
    },
  }))

  useEffect(() => {
    const updateList = (id: string) => {
      search(id, currentKeywordRef.current)
    }
    const handleChange = (ids: string[]) => {
      if (!ids.includes(listState.activeListId)) return
      updateList(listState.activeListId)
    }

    global.state_event.on('mylistToggled', updateList)
    global.app_event.on('myListMusicUpdate', handleChange)

    return () => {
      invalidateSearch()
      global.state_event.off('mylistToggled', updateList)
      global.app_event.off('myListMusicUpdate', handleChange)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const renderItem = ({ item, index }: { item: LX.Music.MusicInfo, index: number }) => {
    return (
      <Button style={styles.item} onPress={() => { onScrollToInfo(item) }} key={index}>
        <View style={styles.itemName}>
          <Text numberOfLines={1}>{item.name}</Text>
          <Text style={styles.subName} numberOfLines={1} size={12} color={theme['c-700']}>{item.singer} ({item.meta.albumName})</Text>
        </View>
        <Text style={styles.itemSource} size={12} color={theme['c-700']}>{item.source}</Text>
      </Button>
    )
  }
  const getkey: SearchTipListProps['keyExtractor'] = item => item.id
  const getItemLayout: SearchTipListProps['getItemLayout'] = (data, index) => {
    return { length: ITEM_HEIGHT, offset: ITEM_HEIGHT * index, index }
  }

  return (
    <SearchTipList
      ref={searchTipListRef}
      renderItem={renderItem}
      onPressBg={dismissResults}
      ListEmptyComponent={<Text accessibilityLiveRegion="polite" style={styles.empty} size={13} color={theme['c-700']}>{t('list_search_no_results')}</Text>}
      keyExtractor={getkey}
      getItemLayout={getItemLayout}
    />
  )
})


const styles = createStyle({
  empty: {
    paddingHorizontal: 15,
    paddingVertical: 12,
  },
  item: {
    height: ITEM_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 15,
    paddingRight: 15,
    // backgroundColor: 'rgba(0, 0, 0, 0.2)',
  },
  itemName: {
    flexGrow: 1,
    flexShrink: 1,
  },
  subName: {
    marginTop: 2,
  },
  itemSource: {
    flexGrow: 0,
    flexShrink: 0,
  },
})

