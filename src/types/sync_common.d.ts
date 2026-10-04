type WarpSyncHandlerActions<Socket, Actions> = {
  [K in keyof Actions]: (...args: [Socket, ...Parameters<Actions[K]>]) => ReturnType<Actions[K]>
}

declare namespace LX {
  namespace Sync {
    /**
     * 本地音乐文件同步：两种角色都暴露同一组方法给对方调用。
     * 传输由用户在任一端手动发起，握手阶段不做任何文件读写。
     */
    interface MusicFilePeerActions {
      musicFile_get_root: () => string
      musicFile_get_index: (scope: string[]) => LX.Sync.MusicFile.FileIndex
      musicFile_read_file: (path: string, offset: number, size: number) => LX.Sync.MusicFile.ReadFileResult
      musicFile_write_file: (path: string, offset: number, data: string, isLast: boolean) => void
    }

    type ServerSyncActions = WarpPromiseRecord<{
      onFeatureChanged: (feature: EnabledFeatures) => void
    } & MusicFilePeerActions>
    type ServerSyncHandlerActions<Socket> = WarpSyncHandlerActions<Socket, ServerSyncActions>

    type ServerSyncListActions = WarpPromiseRecord<{
      onListSyncAction: (action: LX.Sync.List.ActionList) => void
    }>
    type ServerSyncHandlerListActions<Socket> = WarpSyncHandlerActions<Socket, ServerSyncListActions>

    type ServerSyncDislikeActions = WarpPromiseRecord<{
      onDislikeSyncAction: (action: LX.Sync.Dislike.ActionList) => void
    }>
    type ServerSyncHandlerDislikeActions<Socket> = WarpSyncHandlerActions<Socket, ServerSyncDislikeActions>

    type ClientSyncActions = WarpPromiseRecord<{
      getEnabledFeatures: (serverType: ServerType, supportedFeatures: SupportedFeatures) => EnabledFeatures
      finished: () => void
      musicFile_sync_finished: () => void
    } & MusicFilePeerActions>
    type ClientSyncHandlerActions<Socket> = WarpSyncHandlerActions<Socket, ClientSyncActions>

    /** 客户端只负责特性协商的那部分（finished 由 client.ts 内部实现） */
    type ClientSyncHandlerFeatureActions<Socket> = WarpSyncHandlerActions<Socket, WarpPromiseRecord<{
      getEnabledFeatures: (serverType: ServerType, supportedFeatures: SupportedFeatures) => EnabledFeatures
      finished: () => void
    }>>

    type ClientSyncMusicFileActions = WarpPromiseRecord<MusicFilePeerActions & {
      musicFile_sync_finished: () => void
    }>
    type ClientSyncHandlerMusicFileActions<Socket> = WarpSyncHandlerActions<Socket, ClientSyncMusicFileActions>

    type ClientSyncListActions = WarpPromiseRecord<{
      onListSyncAction: (action: LX.Sync.List.ActionList) => void
      list_sync_get_md5: () => string
      list_sync_get_sync_mode: () => LX.Sync.List.SyncMode
      list_sync_get_list_data: () => LX.Sync.List.ListData
      list_sync_set_list_data: (data: LX.Sync.List.ListData) => void
      list_sync_finished: () => void
    }>
    type ClientSyncHandlerListActions<Socket> = WarpSyncHandlerActions<Socket, ClientSyncListActions>

    type ClientSyncDislikeActions = WarpPromiseRecord<{
      onDislikeSyncAction: (action: LX.Sync.Dislike.ActionList) => void
      dislike_sync_get_md5: () => string
      dislike_sync_get_sync_mode: () => LX.Sync.Dislike.SyncMode
      dislike_sync_get_list_data: () => LX.Dislike.DislikeRules
      dislike_sync_set_list_data: (data: LX.Dislike.DislikeRules) => void
      dislike_sync_finished: () => void
    }>
    type ClientSyncHandlerDislikeActions<Socket> = WarpSyncHandlerActions<Socket, ClientSyncDislikeActions>
  }
}


