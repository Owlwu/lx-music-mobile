/**
 * 移动端 Phase 6：一键补全缺失歌词/封面测试
 *
 * 运行：node tests/batch-match.test.mjs
 *
 * 做法（与 tests/music-sidecar.test.mjs、tests/cover-match.test.mjs 同一套路）：
 * 1. 把真实 TS 源码（utils/batchMatch/state.ts、core/batchMatch/{index,select}.ts）复制到临时目录，
 *    把 `@/...` 别名、`react-native-background-timer` 与无扩展名相对导入改写为本地带 `.ts` 的导入；
 * 2. 用替身替换 RN 依赖（fs / localMediaMetadata / coverFile / lrcFile / log / mediaMatch / coverMatch / list），
 *    驱动真实状态判定与批次编排；
 * 3. 覆盖契约 §5/§6：缺失判定真值表（内嵌与独立文件都缺才算缺、空文件按缺失、仅缺失时才读内嵌）、
 *    自动选择顺序（歌词 0 + 最多 4 个 !instrumental && score>=0.6；封面前 3 个）、
 *    取消（开始前/歌词与封面之间/两首之间）、汇总计数、不可写路径与坏文件跳过、UI/core 接线、三语 i18n key。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

let passed = 0
let failed = 0
const failures = []

const check = (name, actual, expected) => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  FAIL ${name}\n       actual   = ${a}\n       expected = ${b}`)
  }
}

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url))
const moduleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-mobile-batch-match-'))

const copyModule = (relPath, destName, rules = []) => {
  let code = fs.readFileSync(path.join(sourceRoot, relPath), 'utf8')
  for (const [rxp, replacement] of rules) code = code.replace(rxp, replacement)
  fs.writeFileSync(path.join(moduleDir, destName), code, 'utf8')
}

const load = async(name) => import(pathToFileURL(path.join(moduleDir, `${name}.ts`)).href)

// ---------------------------------------------------------------------------
// A. 文件状态判定：state.ts 的真实实现 + 可控替身
// ---------------------------------------------------------------------------
copyModule('utils/batchMatch/state.ts', 'state.ts', [
  [/@\/utils\/fs/g, './fs.ts'],
  [/@\/utils\/coverFile/g, './coverFile.ts'],
  [/@\/utils\/lrcFile/g, './lrcFile.ts'],
  [/@\/utils\/localMediaMetadata/g, './localMediaMetadata.ts'],
  [/@\/utils\/log/g, './log.ts'],
])

fs.writeFileSync(path.join(moduleDir, 'fs.ts'), `
const files = new Map()

export const setFile = (filePath, size) => { files.set(filePath, size) }
export const reset = () => { files.clear() }
export const existsFile = async (filePath) => files.has(filePath)
export const stat = async (filePath) => {
  if (!files.has(filePath)) throw new Error('ENOENT: ' + filePath)
  const name = filePath.slice(filePath.lastIndexOf('/') + 1)
  return { name, path: filePath, isDirectory: false, isFile: true, size: files.get(filePath), lastModified: 0 }
}
`, 'utf8')

fs.writeFileSync(path.join(moduleDir, 'coverFile.ts'), `
import { existsFile } from './fs.ts'

export const getCoverImagePathIfExists = async (filePath) => {
  const dirIndex = filePath.lastIndexOf('/')
  const dir = filePath.slice(0, dirIndex + 1)
  const name = filePath.slice(dirIndex + 1)
  const dotIndex = name.lastIndexOf('.')
  const stem = dotIndex > 0 ? name.slice(0, dotIndex) : name
  for (const format of ['jpg', 'png']) {
    const imagePath = dir + stem + '.' + format
    if (await existsFile(imagePath)) return { path: imagePath, format, mtime: 0 }
  }
  return null
}
`, 'utf8')

fs.writeFileSync(path.join(moduleDir, 'lrcFile.ts'), `
export const getLrcFilePath = (filePath) => {
  const dirIndex = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\\\'))
  const dotIndex = filePath.lastIndexOf('.')
  if (dotIndex <= dirIndex) return filePath + '.lrc'
  return filePath.substring(0, dotIndex) + '.lrc'
}
`, 'utf8')

fs.writeFileSync(path.join(moduleDir, 'localMediaMetadata.ts'), `
export const calls = []
export const embedded = {}
export const pics = {}

export const reset = () => {
  calls.length = 0
  for (const key of Object.keys(embedded)) delete embedded[key]
  for (const key of Object.keys(pics)) delete pics[key]
}

export const readEmbeddedLyric = async (filePath) => {
  calls.push(['lyric', filePath])
  const value = embedded[filePath]
  if (value === '__THROW__') throw new Error('embedded lyric read failed')
  return value ?? ''
}

export const readPic = async (filePath) => {
  calls.push(['pic', filePath])
  const value = pics[filePath]
  if (value === '__THROW__') throw new Error('embedded pic read failed')
  return value ?? ''
}
`, 'utf8')

fs.writeFileSync(path.join(moduleDir, 'log.ts'), `
export const logs = []
export const log = {
  info: (...args) => { logs.push(['info', ...args]) },
  warn: (...args) => { logs.push(['warn', ...args]) },
  error: (...args) => { logs.push(['error', ...args]) },
}
`, 'utf8')

const stateModule = await load('state')
const vfs = await load('fs')
const metadata = await load('localMediaMetadata')

const audioPath = '/music/Petit Rabbit - Daydream.mp3'
const lrcPath = '/music/Petit Rabbit - Daydream.lrc'
const upperLrcPath = '/music/Petit Rabbit - Daydream.LRC'
const jpgPath = '/music/Petit Rabbit - Daydream.jpg'
const pngPath = '/music/Petit Rabbit - Daydream.png'

const resetStateFixtures = () => {
  vfs.reset()
  metadata.reset()
  vfs.setFile(audioPath, 2048)
}

const getState = async() => stateModule.getLocalMusicFileState(audioPath)
const kindsOf = async() => stateModule.getMissingKinds(await getState())

console.log('\n== A1 缺失判定真值表：内嵌与独立文件都缺才算缺失 ==')

resetStateFixtures()
let state = await getState()
check('全无：fileExists', state, {
  fileExists: true,
  hasEmbeddedLyric: false,
  hasSidecarLyric: false,
  hasEmbeddedCover: false,
  hasSidecarCover: false,
})
check('全无：歌词/封面都缺失', stateModule.getMissingKinds(state), { lyric: true, cover: true })

resetStateFixtures()
vfs.setFile(lrcPath, 12)
state = await getState()
check('有 .lrc：sidecar 歌词存在', [state.hasSidecarLyric, state.hasEmbeddedLyric], [true, false])
check('有 .lrc：不读内嵌歌词', metadata.calls.filter(call => call[0] === 'lyric').length, 0)
check('有 .lrc：歌词不缺、封面仍缺', stateModule.getMissingKinds(state), { lyric: false, cover: true })

resetStateFixtures()
vfs.setFile(upperLrcPath, 12)
state = await getState()
check('有 .LRC：sidecar 歌词存在', state.hasSidecarLyric, true)

resetStateFixtures()
vfs.setFile(lrcPath, 0)
state = await getState()
check('0 字节 .lrc 按缺失处理', stateModule.getMissingKinds(state).lyric, true)
check('0 字节 .lrc 时读取内嵌歌词', metadata.calls.some(call => call[0] === 'lyric'), true)

resetStateFixtures()
vfs.setFile(lrcPath, 0)
vfs.setFile(upperLrcPath, 8)
state = await getState()
check('.lrc 为空但 .LRC 非空：歌词存在', state.hasSidecarLyric, true)

resetStateFixtures()
metadata.embedded[audioPath] = '[00:01.00]embedded'
state = await getState()
check('内嵌歌词有效', state.hasEmbeddedLyric, true)
check('内嵌歌词有效：歌词不缺、封面仍缺', stateModule.getMissingKinds(state), { lyric: false, cover: true })

resetStateFixtures()
metadata.embedded[audioPath] = '   \n  '
state = await getState()
check('内嵌歌词全空白视为无', state.hasEmbeddedLyric, false)

resetStateFixtures()
metadata.embedded[audioPath] = '__THROW__'
state = await getState()
check('内嵌歌词抛错视为无', state.hasEmbeddedLyric, false)

resetStateFixtures()
vfs.setFile(jpgPath, 12)
state = await getState()
check('有 .jpg：sidecar 封面存在', [state.hasSidecarCover, state.hasEmbeddedCover], [true, false])
check('有 .jpg：不读内嵌封面', metadata.calls.filter(call => call[0] === 'pic').length, 0)
check('有 .jpg：封面不缺、歌词仍缺', stateModule.getMissingKinds(state), { lyric: true, cover: false })

resetStateFixtures()
vfs.setFile(pngPath, 12)
state = await getState()
check('只有 .png：sidecar 封面存在', state.hasSidecarCover, true)

resetStateFixtures()
vfs.setFile(jpgPath, 0)
state = await getState()
check('0 字节 .jpg 按缺失处理', stateModule.getMissingKinds(state).cover, true)
check('0 字节 .jpg 时读取内嵌封面', metadata.calls.some(call => call[0] === 'pic'), true)

resetStateFixtures()
metadata.pics[audioPath] = '/cache/local-media-metadata/pic.jpg'
state = await getState()
check('内嵌封面返回缓存路径视为有', state.hasEmbeddedCover, true)

resetStateFixtures()
metadata.pics[audioPath] = ''
state = await getState()
check('内嵌封面返回空视为无', state.hasEmbeddedCover, false)

resetStateFixtures()
metadata.pics[audioPath] = '__THROW__'
state = await getState()
check('内嵌封面抛错视为无', state.hasEmbeddedCover, false)

resetStateFixtures()
vfs.setFile(lrcPath, 12)
vfs.setFile(jpgPath, 12)
state = await getState()
check('歌词/封面都有：两项都不缺', stateModule.getMissingKinds(state), { lyric: false, cover: false })

resetStateFixtures()
state = await stateModule.getLocalMusicFileState('/music/missing.mp3')
check('音频不存在：fileExists=false 且不读内嵌', [state.fileExists, metadata.calls.length], [false, 0])
check('音频不存在：getMissingKinds 不视作待补全', stateModule.getMissingKinds(state), { lyric: false, cover: false })
check('空路径返回全 false', await stateModule.getLocalMusicFileState(''), stateModule.emptyLocalMusicFileState())

// ---------------------------------------------------------------------------
// B. 自动选择顺序（select.ts 纯函数）
// ---------------------------------------------------------------------------
copyModule('core/batchMatch/select.ts', 'select.ts')
const select = await load('select')

const lyricCandidate = (score, instrumental = false) => ({ score, instrumental })

console.log('\n== B1 歌词尝试顺序：第 1 个 + 1..4 中 !instrumental && score>=0.6 ==')
check('空候选不尝试', select.getLyricAttemptIndexes([]), [])
check('第 1 个总是尝试（即使分低/纯音乐）', select.getLyricAttemptIndexes([lyricCandidate(0.1, true)]), [0])
check('全满足：最多 5 个', select.getLyricAttemptIndexes([
  lyricCandidate(0.9), lyricCandidate(0.9), lyricCandidate(0.9), lyricCandidate(0.9), lyricCandidate(0.9), lyricCandidate(0.9),
]), [0, 1, 2, 3, 4])
check('纯音乐跳过', select.getLyricAttemptIndexes([
  lyricCandidate(0.9), lyricCandidate(0.9, true), lyricCandidate(0.9),
]), [0, 2])
check('分数 < 0.6 跳过', select.getLyricAttemptIndexes([
  lyricCandidate(0.9), lyricCandidate(0.59), lyricCandidate(0.6),
]), [0, 2])
check('分数恰好 0.6 保留', select.getLyricAttemptIndexes([lyricCandidate(0.9), lyricCandidate(0.6)]), [0, 1])
check('第 1 个即使纯音乐/低分也保留', select.getLyricAttemptIndexes([
  lyricCandidate(0.2, true), lyricCandidate(0.8), lyricCandidate(0.2),
]), [0, 1])
check('不足 5 条时按实际长度', select.getLyricAttemptIndexes([lyricCandidate(0.9), lyricCandidate(0.9)]), [0, 1])

console.log('\n== B2 封面尝试顺序：第 1 个 + 最多 2 个回退 ==')
check('空候选不尝试', select.getCoverAttemptIndexes([]), [])
check('1 条只试 1 个', select.getCoverAttemptIndexes([{}]), [0])
check('2 条试 2 个', select.getCoverAttemptIndexes([{}, {}]), [0, 1])
check('5 条最多试 3 个', select.getCoverAttemptIndexes([{}, {}, {}, {}, {}]), [0, 1, 2])

// ---------------------------------------------------------------------------
// C. i18n（三语 key 与占位符）
// ---------------------------------------------------------------------------
console.log('\n== C1 i18n：三语 batch_match__ key 与占位符一致 ==')
const langRoot = path.join(sourceRoot, 'lang')
const langs = ['zh-cn', 'zh-tw', 'en-us'].map(name => ({
  name,
  messages: JSON.parse(fs.readFileSync(path.join(langRoot, `${name}.json`), 'utf8')),
}))
const contractI18n = {
  'batch_match__btn': '一键补全缺失歌词/封面',
  'batch_match__btn_short': '补全',
  'batch_match__title': '一键补全歌词/封面',
  'batch_match__confirm': '将扫描当前列表中的 {total} 首本地歌曲，并为缺少歌词或封面的歌曲自动写入匹配到的第一个结果。仅处理音频内嵌与同目录同名文件中都没有歌词/封面的歌曲。是否继续？',
  'batch_match__scanning': '正在扫描本地文件…',
  'batch_match__scan_current': '扫描中 {current}/{total}：{name}',
  'batch_match__matching': '正在补全…',
  'batch_match__match_current': '{current}/{total}：{name}',
  'batch_match__none': '当前列表没有需要补全的歌曲',
  'batch_match__no_local': '当前列表没有本地歌曲',
  'batch_match__cancel': '取消',
  'batch_match__canceled': '已取消，本次已处理 {done} 首',
  'batch_match__summary': '完成：补全歌词 {lyric} 首，补全封面 {cover} 首；{failed} 首失败，{skipped} 首跳过',
  'batch_match__progress_counts': '补全歌词 {lyric} 首 / 补全封面 {cover} 首 / {failed} 首失败 / {skipped} 首跳过',
}
const getPlaceholders = text => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]))].sort()
const zhCn = langs[0].messages
for (const key of Object.keys(contractI18n)) {
  check(`zh-cn ${key} 文案`, zhCn[key], contractI18n[key])
  for (const lang of langs) {
    const present = typeof lang.messages[key] === 'string' && lang.messages[key].length > 0
    check(`${lang.name} 有 ${key}`, present, true)
  }
  const placeholderSets = langs.map(lang => getPlaceholders(lang.messages[key]))
  check(`${key} 三语占位符一致`, placeholderSets[1], placeholderSets[0])
  check(`${key} 三语占位符一致（en）`, placeholderSets[2], placeholderSets[0])
}
check('三语 key 集合包含全部契约 key', Object.keys(contractI18n).every(key => langs.every(lang => key in lang.messages)), true)

// ---------------------------------------------------------------------------
// D. UI / core 接线（源码静态检查）
// ---------------------------------------------------------------------------
console.log('\n== D1 UI / core 接线 ==')
const readSource = relPath => fs.readFileSync(path.join(sourceRoot, relPath), 'utf8')
const activeListSource = readSource('screens/Home/Views/Mylist/MusicList/ActiveList.tsx')
const musicListSource = readSource('screens/Home/Views/Mylist/MusicList/index.tsx')
const modalSource = readSource('components/BatchMatchModal/index.tsx')
const coreSource = readSource('core/batchMatch/index.ts')
const stateSource = readSource('utils/batchMatch/state.ts')

check('ActiveList 新增 onBatchMatch 属性', activeListSource.includes('onBatchMatch'), true)
check('ActiveList 使用短文案 batch_match__btn_short', activeListSource.includes("batch_match__btn_short"), true)
check('ActiveList 按钮 accessibilityLabel=batch_match__title', activeListSource.includes("accessibilityLabel={t('batch_match__title')}"), true)
check('ActiveList 搜索按钮旁渲染补全按钮', /search-2[\s\S]{0,400}batchMatchBtn/.test(activeListSource), true)
check('MusicList 引入 BatchMatchModal', musicListSource.includes('BatchMatchModal'), true)
check('MusicList 使用 batch_match__confirm 确认', musicListSource.includes('batch_match__confirm'), true)
check('MusicList 无本地歌曲提示 batch_match__no_local', musicListSource.includes('batch_match__no_local'), true)
check('MusicList 确认后以 listId 启动批次', musicListSource.includes('batchMatchRef.current?.show({ listId })'), true)
check('MusicList 从 core/list 读取当前列表', musicListSource.includes('getListMusics') && musicListSource.includes("from '@/core/list'"), true)
check('MusicList 渲染 BatchMatchModal 并接线按钮', musicListSource.includes('<BatchMatchModal ref={batchMatchRef} />') && musicListSource.includes('onBatchMatch={handleBatchMatch}'), true)
check('弹窗使用 common/Dialog', modalSource.includes("from '@/components/common/Dialog'"), true)
check('弹窗显示扫描/补全阶段与当前歌曲', modalSource.includes('batch_match__scanning') && modalSource.includes('batch_match__match_current'), true)
check('弹窗有取消按钮', modalSource.includes('batch_match__cancel') && modalSource.includes('handleCancel'), true)
check('弹窗结束用 toast/tipDialog 汇报', modalSource.includes('batch_match__canceled') && modalSource.includes('batch_match__none') && modalSource.includes('batch_match__summary') && modalSource.includes('tipDialog'), true)
check('core 使用 getListMusics 扫描当前列表', coreSource.includes('getListMusics(listId)'), true)
check('core 使用 state 判定缺失', coreSource.includes('getLocalMusicFileState') && coreSource.includes('getMissingKinds'), true)
check('core 歌词链路完整', ['searchLyrics', 'getCandidateLyric', 'applyLrcToMusic', "source: 'lrc'"].every(token => coreSource.includes(token)), true)
check('core 使用 updateMusicLyricSource', coreSource.includes('updateMusicLyricSource({ listId, musicInfo, source: \'lrc\' })'), true)
check('core 封面链路完整', ['searchCoverCandidates', 'applyCoverCandidate', 'refreshPlayingCover'].every(token => coreSource.includes(token)), true)
check('core 可取消（AbortSignal）', coreSource.includes('signal?: AbortSignal') && coreSource.includes('signal?.aborted'), true)
check('core 每首默认 200ms', coreSource.includes('intervalMs = 200'), true)
check('core 路径不可写跳过（两项都检查）', coreSource.includes('checkLrcMatchablePath') && coreSource.includes('checkCoverMatchablePath'), true)
check('state 用 exists+stat 判非 0 字节', stateSource.includes('existsFile') && stateSource.includes('stat(') && stateSource.includes('size > 0'), true)
check('state 用 getCoverImagePathIfExists', stateSource.includes('getCoverImagePathIfExists'), true)
check('state 仅缺失时读内嵌', /hasSidecarLyric[\s\S]{0,200}readEmbeddedLyric/.test(stateSource) && /hasSidecarCover[\s\S]{0,200}readPic/.test(stateSource), true)

// ---------------------------------------------------------------------------
// E. 批次编排：真实 core/batchMatch/index.ts + 替身
// ---------------------------------------------------------------------------
copyModule('core/batchMatch/index.ts', 'batch.ts', [
  [/react-native-background-timer/g, './backgroundTimer.ts'],
  [/@\/core\/list/g, './list.ts'],
  [/@\/core\/mediaMatch/g, './mediaMatch.ts'],
  [/@\/core\/coverMatch/g, './coverMatch.ts'],
  [/@\/utils\/batchMatch\/state/g, './batchState.ts'],
  [/@\/utils\/coverFile/g, './coverPath.ts'],
  [/@\/utils\/lrcFile/g, './lrcPath.ts'],
  [/@\/utils\/log/g, './log.ts'],
  [/from '\.\/select'/g, "from './select.ts'"],
])
copyModule('core/batchMatch/select.ts', 'select.ts')

fs.writeFileSync(path.join(moduleDir, 'backgroundTimer.ts'), `
export const timers = []
const BackgroundTimer = {
  setTimeout(fn, ms) { timers.push(ms); return setTimeout(fn, 0) },
  clearTimeout(id) { clearTimeout(id) },
}
export default BackgroundTimer
`, 'utf8')

fs.writeFileSync(path.join(moduleDir, 'list.ts'), `
export const calls = []
export const getListMusics = async (listId) => {
  calls.push(listId)
  return globalThis.__lists[listId] ?? []
}
`, 'utf8')

fs.writeFileSync(path.join(moduleDir, 'batchState.ts'), `
export const getLocalMusicFileState = async (filePath) => {
  const state = globalThis.__states[filePath]
  if (state === 'THROW') throw new Error('state failed: ' + filePath)
  if (!state) throw new Error('state not configured: ' + filePath)
  return state
}
export const getMissingKinds = (state) => ({
  lyric: state.fileExists && !state.hasEmbeddedLyric && !state.hasSidecarLyric,
  cover: state.fileExists && !state.hasEmbeddedCover && !state.hasSidecarCover,
})
`, 'utf8')

fs.writeFileSync(path.join(moduleDir, 'lrcPath.ts'), `
export const checkLrcMatchablePath = (filePath) => globalThis.__lrcPathResults[filePath] ?? 'ok'
`, 'utf8')

fs.writeFileSync(path.join(moduleDir, 'coverPath.ts'), `
export const checkCoverMatchablePath = (filePath) => globalThis.__coverPathResults[filePath] ?? 'ok'
`, 'utf8')

fs.writeFileSync(path.join(moduleDir, 'mediaMatch.ts'), `
export const searchLyrics = async (options) => globalThis.__media.searchLyrics(options)
export const getCandidateLyric = async (candidate, signal) => globalThis.__media.getCandidateLyric(candidate, signal)
export const applyLrcToMusic = async (options) => globalThis.__media.applyLrcToMusic(options)
export const updateMusicLyricSource = async (options) => globalThis.__media.updateMusicLyricSource(options)
`, 'utf8')

fs.writeFileSync(path.join(moduleDir, 'coverMatch.ts'), `
export const searchCoverCandidates = async (options) => globalThis.__media.searchCoverCandidates(options)
export const applyCoverCandidate = async (options) => globalThis.__media.applyCoverCandidate(options)
export const refreshPlayingCover = async (musicInfo) => globalThis.__media.refreshPlayingCover(musicInfo)
`, 'utf8')

const batch = await load('batch')
const listStub = await load('list')
const timerStub = await load('backgroundTimer')

const makeMusic = (id, filePath) => ({
  id,
  name: `Song ${id}`,
  singer: 'Singer',
  source: 'local',
  interval: '03:10',
  meta: { filePath, albumName: 'Album', lyricSource: 'embedded' },
})
const makeFileState = (overrides = {}) => ({
  fileExists: true,
  hasEmbeddedLyric: false,
  hasSidecarLyric: false,
  hasEmbeddedCover: false,
  hasSidecarCover: false,
  ...overrides,
})
const makeLyricCandidate = (id, overrides = {}) => ({
  source: 'qq',
  id,
  name: 'Song',
  singer: 'Singer',
  albumName: 'Album',
  durationSec: 190,
  score: 0.9,
  instrumental: false,
  ...overrides,
})
const makeCoverCandidate = (id) => ({
  source: 'qq',
  id,
  name: 'Song',
  singer: 'Singer',
  albumName: 'Album',
  coverUrl: `https://example.test/${id}.jpg`,
  score: 0.9,
})

const mediaCalls = {
  lyricSearch: [],
  getLyric: [],
  applyLyric: [],
  updateSource: [],
  coverSearch: [],
  applyCover: [],
  refreshCover: [],
}
const resetMediaCalls = () => {
  for (const key of Object.keys(mediaCalls)) mediaCalls[key].length = 0
}
const resetBatchFixtures = () => {
  globalThis.__lists = {}
  globalThis.__states = {}
  globalThis.__lrcPathResults = {}
  globalThis.__coverPathResults = {}
  listStub.calls.length = 0
  timerStub.timers.length = 0
  resetMediaCalls()
  globalThis.__media = {
    searchLyrics: async() => [],
    getCandidateLyric: async() => null,
    applyLrcToMusic: async() => ({ lrcPath: '/music/song.lrc' }),
    updateMusicLyricSource: async() => {},
    searchCoverCandidates: async() => [],
    applyCoverCandidate: async() => ({ imagePath: '/music/song.jpg', format: 'jpg' }),
    refreshPlayingCover: async() => true,
  }
}
resetBatchFixtures()

const recordMedia = () => {
  globalThis.__mediaImpl = globalThis.__media
  globalThis.__media = {
    searchLyrics: async(options) => {
      mediaCalls.lyricSearch.push(options.musicInfo.id)
      return globalThis.__mediaImpl.searchLyrics(options)
    },
    getCandidateLyric: async(candidate, signal) => {
      mediaCalls.getLyric.push(candidate.id)
      return globalThis.__mediaImpl.getCandidateLyric(candidate, signal)
    },
    applyLrcToMusic: async(options) => {
      mediaCalls.applyLyric.push(`${options.musicInfo.id}:${options.candidate.id}`)
      return globalThis.__mediaImpl.applyLrcToMusic(options)
    },
    updateMusicLyricSource: async(options) => {
      mediaCalls.updateSource.push(`${options.listId}:${options.musicInfo.id}:${options.source}`)
      return globalThis.__mediaImpl.updateMusicLyricSource(options)
    },
    searchCoverCandidates: async(options) => {
      mediaCalls.coverSearch.push(options.musicInfo.id)
      return globalThis.__mediaImpl.searchCoverCandidates(options)
    },
    applyCoverCandidate: async(options) => {
      mediaCalls.applyCover.push(`${options.musicInfo.id}:${options.candidate.id}`)
      return globalThis.__mediaImpl.applyCoverCandidate(options)
    },
    refreshPlayingCover: async(musicInfo) => {
      mediaCalls.refreshCover.push(musicInfo.id)
      return globalThis.__mediaImpl.refreshPlayingCover(musicInfo)
    },
  }
}

console.log('\n== E1 汇总：只处理缺失项，成功/失败计数 ==')
resetBatchFixtures()
recordMedia()
const songA = makeMusic('a', '/music/A.mp3')
const songB = makeMusic('b', '/music/B.mp3')
const songC = makeMusic('c', '/music/C.mp3')
const onlineSong = { ...makeMusic('online', '/music/Online.mp3'), source: 'online' }
globalThis.__lists.list1 = [songA, songB, songC, onlineSong]
globalThis.__states['/music/A.mp3'] = makeFileState()
globalThis.__states['/music/B.mp3'] = makeFileState({ hasSidecarCover: true })
globalThis.__states['/music/C.mp3'] = makeFileState({ hasEmbeddedLyric: true, hasSidecarLyric: true, hasEmbeddedCover: true, hasSidecarCover: true })
globalThis.__mediaImpl.searchLyrics = async({ musicInfo }) => musicInfo.id === 'a' ? [makeLyricCandidate('lyric-a')] : []
globalThis.__mediaImpl.getCandidateLyric = async() => ({ lyric: '[00:01.00]hello', isSynced: true })
globalThis.__mediaImpl.searchCoverCandidates = async({ musicInfo }) => musicInfo.id === 'a' ? [makeCoverCandidate('cover-a')] : []
const progressEvents = []
const summary = await batch.runBatchMatch({
  listId: 'list1',
  intervalMs: 0,
  onProgress: progress => progressEvents.push(progress),
})
check('汇总计数', summary, {
  canceled: false,
  localTotal: 3,
  total: 2,
  processed: 2,
  lyric: 1,
  cover: 1,
  failed: 1,
  skipped: 0,
})
check('只读取一次当前列表', listStub.calls, ['list1'])
check('非本地歌曲不处理', mediaCalls.lyricSearch.includes('online') || mediaCalls.coverSearch.includes('online'), false)
check('完整歌曲不进入搜索', mediaCalls.lyricSearch.includes('c') || mediaCalls.coverSearch.includes('c'), false)
check('只对缺失歌词的歌曲搜索歌词（a/b）', mediaCalls.lyricSearch, ['a', 'b'])
check('只对缺失封面的歌曲搜索封面（a）', mediaCalls.coverSearch, ['a'])
check('歌词来源切换为 lrc 且带 listId', mediaCalls.updateSource, ['list1:a:lrc'])
check('写盘成功的歌曲刷新播放封面', mediaCalls.refreshCover, ['a'])
check('扫描阶段进度分母=本地歌曲数', progressEvents.filter(event => event.phase === 'scanning').map(event => `${event.current}/${event.total}`), ['1/3', '2/3', '3/3'])
check('补全阶段进度分母=待处理歌曲数', progressEvents.filter(event => event.phase === 'matching').map(event => `${event.current}/${event.total}`), ['1/2', '1/2', '2/2', '2/2'])
check('补全阶段实时计数（第一首结束）', progressEvents.filter(event => event.phase === 'matching')[1], {
  phase: 'matching',
  current: 1,
  total: 2,
  name: 'Song a',
  lyric: 1,
  cover: 1,
  failed: 0,
  skipped: 0,
})
check('补全阶段实时计数（末尾失败 1）', progressEvents.filter(event => event.phase === 'matching').at(-1).failed, 1)

console.log('\n== E2 跳过：本地文件不存在 / 路径不可写 ==')
resetBatchFixtures()
recordMedia()
const missingSong = makeMusic('missing', '/music/Missing.mp3')
const privateSong = makeMusic('private', '/music/Private.mp3')
globalThis.__lists.list2 = [missingSong, privateSong]
globalThis.__states['/music/Missing.mp3'] = makeFileState({ fileExists: false })
globalThis.__states['/music/Private.mp3'] = makeFileState()
globalThis.__lrcPathResults['/music/Private.mp3'] = 'app_private'
globalThis.__coverPathResults['/music/Private.mp3'] = 'app_private'
const skipSummary = await batch.runBatchMatch({ listId: 'list2', intervalMs: 0 })
check('坏文件与不可写路径计 skipped，不进搜索', skipSummary, {
  canceled: false,
  localTotal: 2,
  total: 0,
  processed: 0,
  lyric: 0,
  cover: 0,
  failed: 0,
  skipped: 2,
})
check('跳过时未发起歌词/封面搜索', [mediaCalls.lyricSearch.length, mediaCalls.coverSearch.length], [0, 0])

globalThis.__states['/music/Private.mp3'] = 'THROW'
const throwSummary = await batch.runBatchMatch({ listId: 'list2', intervalMs: 0 })
check('状态探测异常也计 skipped（不中断批次）', throwSummary.skipped, 2)

console.log('\n== E3 歌词自动选择：0 + 最多 4 个 !instrumental && score>=0.6 ==')
resetBatchFixtures()
recordMedia()
const fallbackSong = makeMusic('fallback', '/music/Fallback.mp3')
globalThis.__lists.list3 = [fallbackSong]
globalThis.__states['/music/Fallback.mp3'] = makeFileState({ hasSidecarCover: true })
const candidatesFallback = [
  makeLyricCandidate('c0'),
  makeLyricCandidate('c1', { instrumental: true }),
  makeLyricCandidate('c2', { score: 0.5 }),
  makeLyricCandidate('c3', { score: 0.7 }),
]
globalThis.__mediaImpl.searchLyrics = async() => candidatesFallback
globalThis.__mediaImpl.getCandidateLyric = async(candidate) => {
  if (candidate.id === 'c3') return { lyric: '[00:02.00]fallback', isSynced: true }
  return null
}
const fallbackSummary = await batch.runBatchMatch({ listId: 'list3', intervalMs: 0 })
check('第 1 个无词后按顺序重试，跳过纯音乐/低分', mediaCalls.getLyric, ['c0', 'c3'])
check('回退候选写盘成功', [fallbackSummary.lyric, fallbackSummary.failed], [1, 0])

resetBatchFixtures()
recordMedia()
const manySong = makeMusic('many', '/music/Many.mp3')
globalThis.__lists.list4 = [manySong]
globalThis.__states['/music/Many.mp3'] = makeFileState({ hasSidecarCover: true })
globalThis.__mediaImpl.searchLyrics = async() => Array.from({ length: 7 }, (_, index) => makeLyricCandidate(`m${index}`))
globalThis.__mediaImpl.getCandidateLyric = async() => null
const manySummary = await batch.runBatchMatch({ listId: 'list4', intervalMs: 0 })
check('歌词最多尝试 5 个（0 + 4 回退）', mediaCalls.getLyric, ['m0', 'm1', 'm2', 'm3', 'm4'])
check('全部无有效歌词计失败', [manySummary.lyric, manySummary.failed], [0, 1])

console.log('\n== E4 封面自动选择：前 3 个依次重试 ==')
resetBatchFixtures()
recordMedia()
const coverSong = makeMusic('cover', '/music/Cover.mp3')
globalThis.__lists.list5 = [coverSong]
globalThis.__states['/music/Cover.mp3'] = makeFileState({ hasSidecarLyric: true })
globalThis.__mediaImpl.searchCoverCandidates = async() => ['k0', 'k1', 'k2', 'k3'].map(makeCoverCandidate)
globalThis.__mediaImpl.applyCoverCandidate = async({ candidate }) => {
  if (candidate.id !== 'k2') throw new Error('download failed')
  return { imagePath: '/music/Cover.jpg', format: 'jpg' }
}
const coverSummary = await batch.runBatchMatch({ listId: 'list5', intervalMs: 0 })
check('封面按顺序重试到第 3 个成功', mediaCalls.applyCover, ['cover:k0', 'cover:k1', 'cover:k2'])
check('封面成功不试第 4 个', mediaCalls.applyCover.includes('cover:k3'), false)
check('封面回退成功计数', [coverSummary.cover, coverSummary.failed], [1, 0])

resetBatchFixtures()
recordMedia()
const coverFailSong = makeMusic('coverfail', '/music/CoverFail.mp3')
globalThis.__lists.list6 = [coverFailSong]
globalThis.__states['/music/CoverFail.mp3'] = makeFileState({ hasSidecarLyric: true })
globalThis.__mediaImpl.searchCoverCandidates = async() => ['f0', 'f1', 'f2', 'f3'].map(makeCoverCandidate)
globalThis.__mediaImpl.applyCoverCandidate = async() => { throw new Error('download failed') }
const coverFailSummary = await batch.runBatchMatch({ listId: 'list6', intervalMs: 0 })
check('封面全部失败只试 3 个', mediaCalls.applyCover, ['coverfail:f0', 'coverfail:f1', 'coverfail:f2'])
check('封面全部失败计 failed', coverFailSummary.failed, 1)

console.log('\n== E5 取消：开始前 / 歌词与封面之间 / 两首之间 ==')
resetBatchFixtures()
recordMedia()
const preSong = makeMusic('pre', '/music/Pre.mp3')
globalThis.__lists.list7 = [preSong]
globalThis.__states['/music/Pre.mp3'] = makeFileState()
const preController = new AbortController()
preController.abort()
const preSummary = await batch.runBatchMatch({ listId: 'list7', signal: preController.signal, intervalMs: 0 })
check('开始前已取消：不扫描不搜索', [preSummary.canceled, preSummary.localTotal, preSummary.total, mediaCalls.lyricSearch.length], [true, 1, 0, 0])

resetBatchFixtures()
recordMedia()
const betweenSong = makeMusic('between', '/music/Between.mp3')
globalThis.__lists.list8 = [betweenSong]
globalThis.__states['/music/Between.mp3'] = makeFileState()
const betweenController = new AbortController()
globalThis.__mediaImpl.searchLyrics = async() => [makeLyricCandidate('between-lyric')]
globalThis.__mediaImpl.getCandidateLyric = async() => ({ lyric: '[00:03.00]ok', isSynced: true })
globalThis.__mediaImpl.applyLrcToMusic = async() => {
  betweenController.abort()
  return { lrcPath: '/music/Between.lrc' }
}
const betweenSummary = await batch.runBatchMatch({ listId: 'list8', signal: betweenController.signal, intervalMs: 0 })
check('歌词阶段取消后不再进入封面阶段', mediaCalls.coverSearch, [])
check('歌词已完成、取消计数正确', [betweenSummary.canceled, betweenSummary.processed, betweenSummary.lyric, betweenSummary.cover], [true, 1, 1, 0])

resetBatchFixtures()
recordMedia()
const firstSong = makeMusic('first', '/music/First.mp3')
const secondSong = makeMusic('second', '/music/Second.mp3')
globalThis.__lists.list9 = [firstSong, secondSong]
globalThis.__states['/music/First.mp3'] = makeFileState({ hasSidecarCover: true })
globalThis.__states['/music/Second.mp3'] = makeFileState({ hasSidecarCover: true })
const songsController = new AbortController()
globalThis.__mediaImpl.searchLyrics = async() => [makeLyricCandidate('lyric')]
globalThis.__mediaImpl.getCandidateLyric = async() => ({ lyric: '[00:04.00]ok', isSynced: true })
globalThis.__mediaImpl.applyLrcToMusic = async() => {
  songsController.abort()
  return { lrcPath: '/music/song.lrc' }
}
const songsSummary = await batch.runBatchMatch({ listId: 'list9', signal: songsController.signal, intervalMs: 0 })
check('取消后不再开始下一首', mediaCalls.lyricSearch, ['first'])
check('取消保留已完成结果', [songsSummary.canceled, songsSummary.processed, songsSummary.total, songsSummary.lyric], [true, 1, 2, 1])
check('取消后不再等待歌曲间隔', timerStub.timers.length, 0)

console.log('\n== E6 取消信号透传给搜索 + 空列表 ==')
resetBatchFixtures()
recordMedia()
const signalSong = makeMusic('signal', '/music/Signal.mp3')
globalThis.__lists.list10 = [signalSong]
globalThis.__states['/music/Signal.mp3'] = makeFileState({ hasSidecarCover: true })
const signalController = new AbortController()
let receivedSignal = null
globalThis.__mediaImpl.searchLyrics = async({ signal }) => {
  receivedSignal = signal
  signal?.addEventListener?.('abort', () => {})
  return []
}
const signalSummary = await batch.runBatchMatch({ listId: 'list10', signal: signalController.signal, intervalMs: 0 })
check('搜索收到同一个 AbortSignal', receivedSignal === signalController.signal, true)
check('无候选时计失败且不取消', [signalSummary.failed, signalSummary.canceled], [1, false])

resetBatchFixtures()
recordMedia()
globalThis.__lists.empty = []
const emptySummary = await batch.runBatchMatch({ listId: 'empty', intervalMs: 0 })
check('空列表返回全 0', emptySummary, {
  canceled: false,
  localTotal: 0,
  total: 0,
  processed: 0,
  lyric: 0,
  cover: 0,
  failed: 0,
  skipped: 0,
})

// ---------------------------------------------------------------------------
fs.rmSync(moduleDir, { recursive: true, force: true })
console.log(`\nresult: ${passed} passed, ${failed} failed`)
if (failed) {
  console.log(`failed cases: ${failures.join(', ')}`)
  process.exitCode = 1
}
