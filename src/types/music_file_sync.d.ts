declare namespace LX {
  namespace Sync {
    /**
     * 本地音乐文件同步（PC ↔ Android）
     * 协议与判定规则见 `lx-music-desktop/doc/music-file-sync/本地音乐文件同步-设计.md`
     * 与 `docs/phase6-sync-sidecar-design.md`。
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

      /** 同目录同名的封面（jpg 优先于 png；只认小写扩展名） */
      interface CoverItem {
        format: 'jpg' | 'png'
        size: number
        mtime: number
      }

      /** 跟随歌曲传输/删除的伴生文件（相对路径 + 体积 + 类型） */
      interface SidecarItem {
        path: string
        size: number
        kind: 'lyric' | 'cover'
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
        /** 同目录同名的 .jpg/.png（jpg 优先），不存在时为 null */
        cover: CoverItem | null
        /**
         * 同 stem 的全部封面（jpg / png 同时存在时都保留，jpg 在前）。
         * 旧对端没有该字段时按 `cover` 单值处理；删除靠它避免漏删另一种格式。
         */
        covers?: CoverItem[]
      }

      interface FileIndex {
        folders: string[]
        files: FileItem[]
        /**
         * 新增：本端扫描器是否支持封面索引（新版本恒为 true）。
         * 旧对端没有该字段 → 发起端不传/不删对端封面，避免覆盖。
         */
        coverSupport?: boolean
      }

      interface ReadFileResult {
        /** base64 分片 */
        data: string
        eof: boolean
      }
    }
  }
}
