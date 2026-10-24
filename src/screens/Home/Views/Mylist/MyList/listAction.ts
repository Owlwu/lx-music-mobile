import { addListMusics, getListMusics, removeListMusics, removeUserList, setFetchingListStatus, updateListMusics } from '@/core/list'
import { confirmDialog, handleReadFile, handleSaveFile, showImportTip, toast } from '@/utils/tools'
import { log } from '@/utils/log'
import { importLog } from '@/utils/importLog'
import { filterFileName, convertLegacyMusicList, formatPlayTime2 } from '@/utils'
import { handleImportListPart } from '@/screens/Home/Views/Setting/settings/Backup/actions'
import { readMetadata, scanAudioFiles, type MusicMetadataFull } from '@/utils/localMediaMetadata'
import settingState from '@/store/setting/state'
import BackgroundTimer from 'react-native-background-timer'
import { type FileType } from '@/utils/fs'

export const handleRemove = (listInfo: LX.List.UserListInfo) => {
  void confirmDialog({
    message: global.i18n.t('list_remove_tip', { name: listInfo.name }),
    confirmButtonText: global.i18n.t('list_remove_tip_button'),
  }).then(isRemove => {
    if (!isRemove) return
    void removeUserList([listInfo.id])
  })
}

const readListData = async(path: string) => {
  let configData: any
  try {
    configData = await handleReadFile(path)
  } catch (error: any) {
    log.error(error.stack)
    throw error
  }
  let listData: LX.ConfigFile.MyListInfoPart['data']
  switch (configData.type) {
    case 'playListPart':
      listData = configData.data
      listData.list = convertLegacyMusicList(listData.list)
      break
    case 'playListPart_v2':
      listData = configData.data
      break
    default:
      showImportTip(configData.type as string)
      return null
  }
  return listData
}

export const handleImport = (path: string, position: number) => {
  toast(global.i18n.t('setting_backup_part_import_list_tip_unzip'))
  void readListData(path).then(async listData => {
    if (listData == null) return
    void handleImportListPart(listData, position)
  }).catch((err) => {
    log.error(err)
    toast(global.i18n.t('setting_backup_part_import_list_tip_error'))
  })
}

const exportList = async(listInfo: LX.List.MyListInfo, path: string) => {
  const data = JSON.parse(JSON.stringify({
    type: 'playListPart_v2',
    data: {
      ...listInfo,
      list: await getListMusics(listInfo.id),
    },
  }))
  try {
    await handleSaveFile(`${path}/lx_list_part_${filterFileName(listInfo.name)}.lxmc`, data)
  } catch (error: any) {
    log.error(error.stack)
  }
}
export const handleExport = (listInfo: LX.List.MyListInfo, path: string) => {
  toast(global.i18n.t('setting_backup_part_export_list_tip_zip'))
  exportList(listInfo, path).then(() => {
    toast(global.i18n.t('setting_backup_part_export_list_tip_success'))
  }).catch((err: any) => {
    log.error(err.message)
    toast(global.i18n.t('setting_backup_part_export_list_tip_failed') + ': ' + (err.message as string))
  })
}

export const buildLocalMusicInfoByFilePath = (file: FileType): LX.Music.MusicInfoLocal => {
  const index = file.name.lastIndexOf('.')
  return {
    id: file.path,
    name: file.name.substring(0, index),
    singer: '',
    source: 'local',
    interval: null,
    meta: {
      albumName: '',
      filePath: file.path,
      songId: file.path,
      picUrl: '',
      ext: file.name.substring(index + 1),
    },
  }
}
export const buildLocalMusicInfo = (filePath: string, metadata: MusicMetadataFull): LX.Music.MusicInfoLocal => {
  return {
    id: filePath,
    name: metadata.name,
    singer: metadata.singer,
    source: 'local',
    interval: formatPlayTime2(metadata.interval),
    meta: {
      albumName: metadata.albumName,
      filePath,
      songId: filePath,
      picUrl: '',
      ext: metadata.ext,
    },
  }
}
const createLocalMusicInfos = async(filePaths: string[], errorPath: string[]): Promise<LX.Music.MusicInfoLocal[]> => {
  const list: LX.Music.MusicInfoLocal[] = []
  filePaths = [...filePaths]
  while (filePaths.length) {
    const tasks = [
      filePaths.shift(),
      filePaths.shift(),
      filePaths.shift(),
      filePaths.shift(),
      filePaths.shift(),
    ].filter(Boolean) as string[]

    await Promise.all(tasks.map(async path => readMetadata(path).then(info => ([path, info] as const)))).then((res) => {
      for (const [path, info] of res) {
        if (!info) {
          errorPath.push(path)
          continue
        }
        list.push(buildLocalMusicInfo(path, info))
      }
    })
  }
  return list
}

const createThrottleAddMusics = (add: (listId: string, musicInfos: LX.Music.MusicInfoLocal[]) => Promise<void>, remove: (listId: string, errorPath: string[]) => Promise<void>, listId: string) => {
  let timer: number | null = null
  let _musicInfos: LX.Music.MusicInfoLocal[] = []
  let _errorPath: string[] = []
  return (musicInfos: LX.Music.MusicInfoLocal[], errorPath?: string[]) => {
    if (musicInfos.length) _musicInfos = [..._musicInfos, ...musicInfos]
    if (errorPath) _errorPath = [..._errorPath, ...errorPath]
    if (timer) return
    timer = BackgroundTimer.setTimeout(async() => {
      timer = null
      let musicInfos = _musicInfos
      _musicInfos = []
      let errorPath = _errorPath
      _errorPath = []
      if (musicInfos.length) await add(listId, musicInfos)
      if (errorPath.length) await remove(listId, errorPath)
    }, 1000)
  }
}

/**
 * 一次导入最多在日志里逐个列出多少失败文件。
 *
 * 导入整个曲库时失败文件可能上千个，全列出来会把「查看日志」撑得没法看，
 * 因此超出后只留一行汇总，剩下的靠「重新导入」时的提示确认。
 */
const maxImportLogFailedFiles = 200

const handleUpdateMusics = async(filePaths: string[],
  throttleUpdateMusics: (musicInfos: LX.Music.MusicInfoLocal[], errorPath?: string[]) => void, index: number = -1, total: number = 0, errorPath: string[] = []) => {
  // console.log(index + 1, index + 201)
  if (!total) total = filePaths.length
  const paths = filePaths.slice(index + 1, index + 11)
  const musicInfos = await createLocalMusicInfos(paths, errorPath)
  if (musicInfos.length) throttleUpdateMusics(musicInfos)
  index += 10
  if (filePaths.length - 1 > index) await handleUpdateMusics(filePaths, throttleUpdateMusics, index, total, errorPath)
  else {
    if (errorPath.length) {
      importLog.warn('读取歌曲信息失败，这些文件未能导入', { total, failed: errorPath.length })
      for (const filePath of errorPath.slice(0, maxImportLogFailedFiles)) {
        importLog.warn('  - 失败文件', { path: filePath })
      }
      if (errorPath.length > maxImportLogFailedFiles) {
        importLog.warn('  - 其余失败文件已省略', { omitted: errorPath.length - maxImportLogFailedFiles })
      }
      toast(global.i18n.t('list_select_local_file_result_failed_tip', { total, success: total - errorPath.length, failed: errorPath.length }), 'long')
    } else {
      toast(global.i18n.t('list_select_local_file_result_tip', { total }), 'long')
    }
    importLog.info('导入本地歌曲完成', { total, success: total - errorPath.length, failed: errorPath.length })
    throttleUpdateMusics([], errorPath)
  }
}
export const handleImportMediaFile = async(listInfo: LX.List.MyListInfo, path: string) => {
  setFetchingListStatus(listInfo.id, true)
  importLog.info('开始导入本地歌曲', { list: listInfo.name, dir: path })
  try {
    const files = await scanAudioFiles(path)
    importLog.info('扫描导入目录完成', { dir: path, total: files.length })
    if (files.length) {
      const throttleUpdateMusics = createThrottleAddMusics(async(listId, musicInfos) => {
        return updateListMusics(musicInfos.map(info => ({ id: listId, musicInfo: info })))
      }, async(listId, errorPath) => {
        return removeListMusics(listId, errorPath)
      }, listInfo.id)
      await addListMusics(listInfo.id, files.map(buildLocalMusicInfoByFilePath), settingState.setting['list.addMusicLocationType'])
      toast(global.i18n.t('list_select_local_file_temp_add_tip', { total: files.length }), 'long')
      await handleUpdateMusics(files.map(f => f.path), throttleUpdateMusics)
    } else {
      importLog.warn('目录下没有可导入的音频文件', { dir: path })
      toast(global.i18n.t('list_select_local_file_empty_tip'), 'long')
    }
  } catch (error: any) {
    // 整条导入链路意外中断（例如写入歌曲列表失败、读取标签时原生模块抛错）：
    // 必须记进导入日志并提示用户，否则「查看日志」里会看不到任何痕迹。
    importLog.warn('导入本地歌曲失败', {
      dir: path,
      list: listInfo.name,
      error: error?.stack ?? error?.message ?? error,
    })
    toast(global.i18n.t('list_select_local_file_import_error_tip', { message: error?.message ?? String(error) }), 'long')
  } finally {
    // 无论成功、失败还是抛错都要复位，否则列表会一直显示「正在读取文件标签」
    setFetchingListStatus(listInfo.id, false)
  }
}
