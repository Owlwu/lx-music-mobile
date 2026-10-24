declare namespace LX {
  namespace Music {
    interface MusicInfoMeta {
      songId: string | number // 歌曲ID（本地歌曲为文件路径）
      albumName: string // 歌曲专辑名称
      picUrl?: string | null // 歌曲图片
      filePath: string
      ext: string
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

  }
}
