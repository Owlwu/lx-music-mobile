declare namespace LX {
  namespace Sync {
    /**
     * 本地音乐文件同步（PC ↔ Android）
     * 协议与判定规则见 `lx-music-desktop/doc/music-file-sync/本地音乐文件同步-设计.md`
     *
     * 注意：手机端只实现「对端 RPC」这一半（同步一律由 PC 发起），
     * 因此这里只保留协议实际用到的类型；变更清单、进度、同步基线等
     * 「发起方」才需要的类型都在 PC 端。
     */
    namespace MusicFile {
      interface LyricItem {
        size: number
        mtime: number
      }

      interface FileItem {
        /** 相对同步根目录的路径，使用 `/` 分隔 */
        path: string
        size: number
        mtime: number
        /**
         * 内容签名（首尾各取 4096 字节算出，见 `diff.ts` 的 `buildSignature`）。
         * 用于发现「字节数相同但内容不同」的文件；对端版本较旧或取样失败时为空。
         */
        sig?: string
        /** 同目录同名的 .lrc，不存在时为 null */
        lyric: LyricItem | null
      }

      interface FileIndex {
        folders: string[]
        files: FileItem[]
      }

      interface ReadFileResult {
        /** base64 分片 */
        data: string
        eof: boolean
      }
    }
  }
}
