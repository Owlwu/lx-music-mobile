import { getMusicVolume } from '@/utils/data'
import { setVolume } from '@/plugins/player'
import settingState from '@/store/setting/state'

/**
 * 单曲音量基准值。
 * 用户单曲系数为 1（100%）时，实际输出为全局音量的 90%，预留余量避免削波。
 */
export const MUSIC_VOLUME_BASE = 0.9
export const MUSIC_VOLUME_MIN = 0.1
export const MUSIC_VOLUME_MAX = 2

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

export const normalizeMusicInfo = (musicInfo: LX.Player.PlayMusic): LX.Music.MusicInfo => {
  return 'progress' in musicInfo ? musicInfo.metadata.musicInfo : musicInfo
}

// 当前播放歌曲的内存缓存，用于全局音量变化 / 拖动滑块时即时重算
let currentMusicId: string | null = null
let currentVolumeFactor = 1

export const getEffectiveVolume = (globalVolume: number, factor: number) => {
  return clamp(globalVolume * MUSIC_VOLUME_BASE * factor, 0, 1)
}

/**
 * 使用当前的单曲系数，按传入的全局音量重新计算并应用实际播放音量
 */
export const applyGlobalVolume = async(globalVolume: number = settingState.setting['player.volume']) => {
  await setVolume(getEffectiveVolume(globalVolume, currentVolumeFactor))
}

/**
 * 更新当前歌曲的单曲系数缓存并立即应用
 */
export const setCurrentVolumeFactor = async(factor: number) => {
  currentVolumeFactor = clamp(factor, MUSIC_VOLUME_MIN, MUSIC_VOLUME_MAX)
  await applyGlobalVolume()
}

/**
 * 切歌时读取该歌曲持久化的音量系数并应用。
 * 使用歌曲 id 做竞态保护，避免异步读取期间切歌导致错用系数。
 */
export const applyMusicVolume = async(musicInfo: LX.Player.PlayMusic | null) => {
  if (musicInfo == null) {
    currentMusicId = null
    currentVolumeFactor = 1
    return applyGlobalVolume()
  }

  const id = normalizeMusicInfo(musicInfo).id
  currentMusicId = id

  const factor = await getMusicVolume(normalizeMusicInfo(musicInfo))
  // 读取期间已切歌，丢弃过期结果
  if (currentMusicId !== id) return
  currentVolumeFactor = clamp(factor, MUSIC_VOLUME_MIN, MUSIC_VOLUME_MAX)
  return applyGlobalVolume()
}
