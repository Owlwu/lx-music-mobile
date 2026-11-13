declare namespace LX {
  namespace Music {
    /**
     * 歌词来源
     * - embedded: 音频文件内嵌歌词
     * - lrc: 歌曲同目录同名的外挂 .lrc 文件
     */
    type LyricSource = 'embedded' | 'lrc'

    /**
     * 在线歌词匹配数据源
     */
    type LyricsSource = 'lrclib' | 'qq'

    interface MusicInfoMeta {
      songId: string | number // 歌曲ID（本地歌曲为文件路径）
      albumName: string // 歌曲专辑名称
      picUrl?: string | null // 歌曲图片
      filePath: string
      ext: string
      /**
       * 单曲歌词来源偏好；未设置时使用全局设置 player.lyricSource
       */
      lyricSource?: LyricSource
    }

    interface MusicInfo {
      id: string
      name: string // 歌曲名
      singer: string // 艺术家名
      source: 'local' // 本分支只有本地歌曲
      interval: string | null // 格式化后的歌曲时长，例：03:55
      meta: MusicInfoMeta
    }

    // 历史命名，等价于 MusicInfo（本地歌曲）
    type MusicInfoLocal = MusicInfo

    interface LyricInfo {
      // 歌曲歌词
      lyric: string
      // 翻译歌词
      tlyric?: string | null
      // 罗马音歌词
      rlyric?: string | null
      // 逐字歌词
      lxlyric?: string | null
    }

    interface LyricInfoSave {
      id: string
      lyrics: LyricInfo
    }

    /**
     * 在线歌词匹配的查询信息（纯逻辑模块的共用契约）
     */
    interface MatchQuery {
      name: string
      singer: string
      albumName: string
      durationSec: number | null
      /** 歌曲文件名去掉扩展名（原样） */
      fileStem: string
      /** 生成的候选查询串，按优先级排列 */
      variants: string[]
    }

    /**
     * 在线歌词匹配候选
     */
    interface LyricsCandidate {
      source: LyricsSource
      /** 源内唯一 id（LRCLIB 数字 id；QQ songmid） */
      id: string
      name: string
      singer: string
      albumName: string
      durationSec: number | null
      /** 是否带时间轴；null = 取词后才能确定（QQ 搜索阶段未知） */
      hasSynced: boolean | null
      /** 推断值（标题/占位文本），仅供 UI 提示，不参与硬过滤 */
      instrumental: boolean
      /** 0..1，见设计 §2.4 */
      score: number
      /**
       * 仅 provider 内部缓存用，不跨 IPC 传递；
       * 应用/预览时应通过 provider 的 getLyric 取词。
       */
      lyric?: string
    }

    /**
     * 在线封面数据源 id
     */
    type CoverSource = 'qq' | 'itunes'

    /**
     * 在线封面候选；同一专辑只保留一条（专辑维度去重）
     */
    interface CoverCandidate {
      source: CoverSource
      /** 源内唯一 id（QQ albummid / iTunes collectionId） */
      id: string
      name: string
      singer: string
      albumName: string
      durationSec: number | null
      /** 大图（QQ R500 / iTunes 600x600bb） */
      coverUrl: string
      /** 缩略图（QQ R150 / iTunes 100x100bb） */
      thumbnailUrl: string
      /** 0..1，标题/歌手/时长 + 专辑加分 */
      score: number
    }

    /**
     * 歌曲同目录同名封面 / 备份状态（读取优先 jpg，再 png）
     */
    interface CoverState {
      imagePath?: string
      imageFormat?: 'jpg' | 'png'
      imageExists: boolean
      backupExists: boolean
      imageSize?: number
      imageMtime?: number
    }

    /**
     * 应用封面后的结果
     */
    interface CoverApplyResult {
      /** 实际写入的同名图片路径 */
      imagePath: string
      format: 'jpg' | 'png'
      /** 本次是否新建了 `.bak` */
      backupCreated: boolean
    }

  }
}
