declare namespace LX {
  namespace Sync {
    /**
     * 本地音乐文件同步（PC ↔ Android）
     * 协议与判定规则见 `lx-music-desktop/doc/music-file-sync/本地音乐文件同步-设计.md`
     */
    namespace MusicFile {
      interface FileItem {
        /** 相对同步根目录的路径，使用 `/` 分隔 */
        path: string
        size: number
        mtime: number
      }

      interface FileIndex {
        folders: string[]
        files: FileItem[]
      }

      type FileGroupKey = 'remoteAdded' | 'localAdded'

      type TransferDirection = 'push' | 'pull'

      interface PlanItem {
        group: FileGroupKey
        path: string
        localSize: number | null
        remoteSize: number | null
        defaultChecked: boolean
        defaultDirection: TransferDirection
      }

      type PlanGroups = Record<FileGroupKey, PlanItem[]>

      type TransferActionKind = 'download' | 'upload'

      interface ReadFileResult {
        /** base64 分片 */
        data: string
        eof: boolean
      }

      interface FolderNode {
        name: string
        /** 相对同步根目录的路径 */
        path: string
        /** 当前文件夹内的音频数量 */
        audioCount: number
        /** 含子文件夹的音频总数 */
        totalCount: number
        children: FolderNode[]
      }

      interface Config {
        /** 同步歌曲存放路径（本机绝对路径） */
        root: string
        /** 已勾选的文件夹相对路径，空数组表示根目录全部 */
        scope: string[]
      }

      interface CompareResult {
        plan: PlanGroups
        localRoot: string
        remoteRoot: string
        remoteDeviceName: string
      }

      type ProgressStage = 'idle' | 'comparing' | 'transferring' | 'finishing' | 'done' | 'error'

      interface Progress {
        running: boolean
        stage: ProgressStage
        /** 当前动作类型 */
        kind: TransferActionKind | ''
        /** 当前处理的相对路径 */
        path: string
        /** 已完成的动作数 */
        actionIndex: number
        /** 需要执行的动作总数 */
        actionTotal: number
        /** 当前文件已传输字节数 */
        fileBytes: number
        /** 当前文件总字节数 */
        fileBytesTotal: number
        /** 全部动作的总字节数 */
        totalBytes: number
        /** 已传输的总字节数 */
        doneBytes: number
        message: string
        errors: string[]
      }

      interface Selection {
        /** key 为 `${group}:${path}` */
        checked: Record<string, boolean>
      }

      interface ApplyResult {
        downloaded: number
        uploaded: number
        errors: string[]
      }
    }
  }
}
