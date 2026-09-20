import { memo } from 'react'

import Section from '../../components/Section'
import AddMusicLocationType from './AddMusicLocationType'
import IsClickPlayList from './IsClickPlayList'
import IsDeleteLocalFileWhenRemove from './IsDeleteLocalFileWhenRemove'
import IsShowAlbumName from './IsShowAlbumName'
import IsShowInterval from './IsShowInterval'

import { useI18n } from '@/lang'

export default memo(() => {
  const t = useI18n()

  return (
    <Section title={t('setting_list')}>
      <IsClickPlayList />
      <IsShowAlbumName />
      <IsDeleteLocalFileWhenRemove />
      <IsShowInterval />
      <AddMusicLocationType />
    </Section>
  )
})
