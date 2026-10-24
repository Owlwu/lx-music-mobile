import { Linking } from 'react-native'
import { errorDialog } from './utils'
import { extname, stat } from '@/utils/fs'
import { handleFileMusicAction, handleFileLXMCAction } from './fileAction'


const handleFileAction = async(link: string) => {
  const file = await stat(link)
  switch (extname(file.name)) {
    case 'json':
    case 'lxmc':
      await handleFileLXMCAction(file)
      break
    case 'ogg':
    case 'flac':
    case 'wav':
    case 'mp3':
      await handleFileMusicAction(file)
      break
    default:
      if (!file.mimeType?.startsWith('audio/')) throw new Error('Unknown file type')
      await handleFileMusicAction(file)
      break
  }
}

const runLinkAction = async(link: string) => {
  if (link.startsWith('file://') || link.startsWith('content://')) {
    try {
      await handleFileAction(link)
    } catch (err: any) {
      errorDialog(err.message)
    }
  }
}

export const initDeeplink = async() => {
  Linking.addEventListener('url', ({ url }) => {
    void runLinkAction(url)
  })
  const initialUrl = await Linking.getInitialURL()
  if (initialUrl == null) return
  void runLinkAction(initialUrl)
}
