/**
 * 移动端 Phase 4：在线歌词匹配的中文翻译 / 罗马音测试
 *
 * 运行：node tests/lyrics-translation.test.mjs
 *
 * 做法（与 tests/cover-match.test.mjs 同一套路）：
 * 1. 把真实 TS 源码（lrcText / netease provider / validateLyric / query / normalize）复制到临时目录，
 *    把 `@/...` 别名、`react-native-background-timer` 与无扩展名的相对导入改写为带 `.ts` 的本地导入；
 *    另外从 core/music/local.ts 抽出真实 `parseLyric`，验证扩展段回读；
 * 2. 用本地 stub 替换 httpFetch / log / BackgroundTimer，驱动真实 netease provider，
 *    断言请求头、URL、去重、关键词变体上限、降级与隐私（日志不含歌词/URL）；
 * 3. 覆盖契约 §6.1：buildLrcText 无扩展数据逐字节回归、扩展段 base64/顺序/清洗、空翻译不写 tlrc、
 *    getLyricPreviewEntries 插行/上限/时间归一、netease 搜索映射/取词/nolyric/romalrc→yromalrc，
 *    以及 parseLyric 回读 tlyric/rlyric。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Lyric from 'lrc-file-parser'

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

const checkThrows = async(name, fn, rxp) => {
  try {
    await fn()
    failed++
    failures.push(name)
    console.log(`  FAIL ${name} (no throw)`)
  } catch (err) {
    const message = err?.message ?? String(err)
    if (!rxp || rxp.test(message)) {
      passed++
      console.log(`  ok   ${name}`)
    } else {
      failed++
      failures.push(name)
      console.log(`  FAIL ${name}\n       error   = ${message}\n       expected = ${rxp}`)
    }
  }
}

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url))
const moduleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-mobile-lyrics-translation-'))

const copyModule = (relPath, destName = path.basename(relPath)) => {
  const code = fs.readFileSync(path.join(sourceRoot, relPath), 'utf8')
    .replace(/from 'react-native-background-timer'/g, "from './backgroundTimer.ts'")
    .replace(/(['"])@\/utils\/request\1/g, "'./request.ts'")
    .replace(/(['"])@\/utils\/log\1/g, "'./log.ts'")
    .replace(/(['"])@\/utils\/mediaMatch\/query\1/g, "'./query.ts'")
    .replace(/(['"])@\/utils\/mediaMatch\/normalize\1/g, "'./normalize.ts'")
    .replace(/(['"])@\/utils\/mediaMatch\/lrcText\1/g, "'./lrcText.ts'")
    .replace(/(['"])\.\.\/validateLyric\1/g, "'./validateLyric.ts'")
    .replace(/from '\.\/([A-Za-z0-9_]+)'/g, "from './$1.ts'")
  fs.writeFileSync(path.join(moduleDir, destName), code, 'utf8')
}

copyModule('utils/mediaMatch/normalize.ts')
copyModule('utils/mediaMatch/query.ts')
copyModule('utils/mediaMatch/lrcText.ts')
copyModule('core/mediaMatch/validateLyric.ts')
copyModule('core/mediaMatch/providers/netease.ts')

// 真实 parseLyric（core/music/local.ts）抽出，验证 [awlrc:lrc,tlrc,rlrc] 回读
const localSource = fs.readFileSync(path.join(sourceRoot, 'core/music/local.ts'), 'utf8')
const parseStart = localSource.indexOf('export const parseLyric')
const parseEnd = localSource.indexOf('\nexport const getPreferredLyricSource', parseStart)
if (parseStart < 0 || parseEnd < 0) throw new Error('parseLyric source not found')
fs.writeFileSync(path.join(moduleDir, 'parseLyric.ts'), `${localSource.slice(parseStart, parseEnd).trim()}\n`, 'utf8')

// httpFetch stub：记录请求，由每个用例设置 handler 返回 { statusCode, body }
fs.writeFileSync(path.join(moduleDir, 'request.ts'), `
export const requests = []
let handler = () => { throw new Error('no http handler') }

export const setHttpHandler = (fn) => { handler = fn }
export const resetRequests = () => { requests.length = 0 }

export const httpFetch = (url, options = {}) => {
  const record = { url, options, canceled: false }
  requests.push(record)
  const promise = Promise.resolve().then(() => handler(record))
  return {
    promise,
    cancelHttp() { record.canceled = true },
  }
}
`, 'utf8')

// log stub：只收集，不落盘
fs.writeFileSync(path.join(moduleDir, 'log.ts'), `
export const logs = []
export const resetLogs = () => { logs.length = 0 }
export const log = {
  info: (...args) => { logs.push(['info', ...args]) },
  warn: (...args) => { logs.push(['warn', ...args]) },
  error: (...args) => { logs.push(['error', ...args]) },
  debug: (...args) => { logs.push(['debug', ...args]) },
}
`, 'utf8')

// BackgroundTimer stub：串行间隔的 sleep 立即完成，测试不真的等 300ms
fs.writeFileSync(path.join(moduleDir, 'backgroundTimer.ts'), `
const timer = {
  setTimeout(fn, _ms) { return setTimeout(fn, 0) },
  clearTimeout(id) { clearTimeout(id) },
}
export default timer
`, 'utf8')

const load = async(name) => import(pathToFileURL(path.join(moduleDir, `${name}.ts`)).href)

const lrcText = await load('lrcText')
const netease = await load('netease')
const { parseLyric } = await load('parseLyric')
const requestStub = await load('request')
const logStub = await load('log')

const readSrc = (relPath) => fs.readFileSync(path.join(sourceRoot, relPath), 'utf8')

const decodeBase64 = (value) => Buffer.from(value, 'base64').toString('utf8')
const extractExtendedTag = (text) => {
  const match = /\n\n\[awlrc:([^\]]+)]\n$/.exec(text)
  return match ? match[1] : null
}
const parseSegments = (tag) => tag.split(',').map(segment => {
  const index = segment.indexOf(':')
  return { name: segment.slice(0, index), value: decodeBase64(segment.slice(index + 1)) }
})
const parseLogs = () => logStub.logs.map(item => item.slice(1).map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' '))

// ---------------------------------------------------------------- 测试数据

const mainLyric = [
  '[ti:打上花火]',
  '[ar:DAOKO / 米津玄師]',
  '[00:00.000]打上花火',
  '[00:04.500]あの日見た花の名前を',
  '[00:08.250]僕たちはまだ知らない',
].join('\n')

const tlyric = [
  '[by:Translation]',
  '[offset:0]',
  '[00:00.000]打上花火',
  '[00:04.500]那天看见的花的名字',
  '[00:08.250]我们仍未知晓',
  '[00:10.000]//',
].join('\r\n')

const rlyric = [
  '[00:00.000]uchiage hanabi',
  '[00:04.500]ano hi mita hana no namae wo',
  '[00:08.250]bokutachi wa mada shiranai',
].join('\n')

const plainCandidate = {
  name: 'Song',
  singer: 'Artist',
  albumName: 'Album',
  lyric: '[00:01.000]line1\r\n[00:02.500]line2\r\n',
  isSynced: true,
}

const makeQuery = (variants) => ({
  name: 'Song',
  singer: 'Artist',
  albumName: 'Album',
  durationSec: 235,
  fileStem: 'Artist - Song',
  variants,
})

const makeCandidate = (overrides = {}) => ({
  source: 'netease',
  id: '123',
  name: 'Song',
  singer: 'Artist',
  albumName: 'Album',
  durationSec: 235,
  hasSynced: null,
  instrumental: false,
  score: 0,
  ...overrides,
})

const resetHttp = (handler) => {
  requestStub.resetRequests()
  logStub.resetLogs()
  requestStub.setHttpHandler(handler)
}

const jsonResponse = (body) => ({ statusCode: 200, body })
const searchResponse = (songs) => ({ statusCode: 200, body: { code: 200, result: { songs } } })
const searchKeyword = (record) => new URL(record.url).searchParams.get('s')

// ---------------------------------------------------------------- §1 buildLrcText 回归

console.log('\n== §1 buildLrcText：无扩展数据时逐字节回归 ==')

const legacyExpected = '[ti:Song]\n[ar:Artist]\n[al:Album]\n[00:01.000]line1\n[00:02.500]line2\n'
check('基础输出与旧版一致（头 + 正文 + 结尾换行）', lrcText.buildLrcText(plainCandidate), legacyExpected)
check('CRLF 统一为 LF', lrcText.buildLrcText({ ...plainCandidate, lyric: '[00:01.000]a\r\n[00:02.500]b' }), '[ti:Song]\n[ar:Artist]\n[al:Album]\n[00:01.000]a\n[00:02.500]b\n')
check('空 tlyric/rlyric 不改变输出', lrcText.buildLrcText({ ...plainCandidate, tlyric: '', rlyric: '' }), legacyExpected)
check('纯空白 tlyric/rlyric 不改变输出', lrcText.buildLrcText({ ...plainCandidate, tlyric: '\r\n  \n', rlyric: '  ' }), legacyExpected)
check('源 [ti:]/[ar:]/[al:]/[by:] 行被剔除', lrcText.buildLrcText({
  ...plainCandidate,
  lyric: '[ti:Source]\n[ar:Source]\n[al:Source]\n[by:Someone]\n[00:01.000]line1\n[offset:0]\n[00:02.500]line2',
}), '[ti:Song]\n[ar:Artist]\n[al:Album]\n[00:01.000]line1\n[offset:0]\n[00:02.500]line2\n')
check('词级时间标签 <0,300> 被剔除', lrcText.buildLrcText({ ...plainCandidate, lyric: '[00:01.000]<0,300>Hello\n[00:02.500]<500,300>World' }), '[ti:Song]\n[ar:Artist]\n[al:Album]\n[00:01.000]Hello\n[00:02.500]World\n')
check('连续空行合并、首尾空行去掉', lrcText.buildLrcText({ ...plainCandidate, lyric: '\n\n[00:01.000]a\n\n\n[00:02.500]b\n\n\n' }), '[ti:Song]\n[ar:Artist]\n[al:Album]\n[00:01.000]a\n\n[00:02.500]b\n')
check('头部为空不写 tag', lrcText.buildLrcText({ name: '', singer: '', albumName: '', lyric: '[00:01.000]a', isSynced: true }), '[00:01.000]a\n')
check('空歌词返回空串', lrcText.buildLrcText({ name: '', singer: '', albumName: '', lyric: '', isSynced: false }), '')
check('无扩展数据 buildExtendedLrcText 原样返回 body', lrcText.buildExtendedLrcText('[ti:X]\n[00:01.000]a\n'), '[ti:X]\n[00:01.000]a\n')
check('空 body + 无扩展数据返回空串', lrcText.buildExtendedLrcText(''), '')
check('空 body + 有扩展数据也不写标签', lrcText.buildExtendedLrcText('', { tlyric: '[00:01.000]甲' }), '')
check('isSynced=false 时保留原时间标签（旧行为不变）', lrcText.buildLrcText({ ...plainCandidate, isSynced: false }), legacyExpected)

// ---------------------------------------------------------------- §2 扩展段

console.log('\n== §2 扩展段：base64 / 顺序 / 清洗 / 空翻译 ==')

const legacyBody = lrcText.buildLrcText({
  name: '打上花火',
  singer: 'DAOKO / 米津玄師',
  albumName: '',
  lyric: mainLyric,
  isSynced: true,
})
const extendedText = lrcText.buildLrcText({
  name: '打上花火',
  singer: 'DAOKO / 米津玄師',
  albumName: '',
  lyric: mainLyric,
  isSynced: true,
  tlyric,
  rlyric,
})
check('扩展文本以旧版正文开头（无扩展时逐字节一致）', extendedText.startsWith(legacyBody.trimEnd() + '\n\n[awlrc:'), true)
check('扩展标签独占一行且结尾换行', /\n\n\[awlrc:[^\]]+]\n$/.test(extendedText), true)
check('扩展标签只出现一次', extendedText.split('[awlrc:').length - 1, 1)

const extendedTag = extractExtendedTag(extendedText)
const extendedSegments = parseSegments(extendedTag)
check('段顺序固定 lrc → tlrc → rlrc', extendedSegments.map(segment => segment.name), ['lrc', 'tlrc', 'rlrc'])
check('lrc 段 = 完整正文去尾部空白', extendedSegments[0].value, legacyBody.trimEnd())
check('tlrc 段清洗后 = 翻译行', extendedSegments[1].value, '[00:00.000]打上花火\n[00:04.500]那天看见的花的名字\n[00:08.250]我们仍未知晓')
check('rlrc 段 = 罗马音行', extendedSegments[2].value, rlyric)

const onlyTranslation = lrcText.buildLrcText({ ...plainCandidate, tlyric })
const onlyTranslationSegments = parseSegments(extractExtendedTag(onlyTranslation))
check('只有翻译：lrc + tlrc 两段', onlyTranslationSegments.map(segment => segment.name), ['lrc', 'tlrc'])
check('只有翻译：不写 rlrc', onlyTranslation.includes('rlrc:'), false)

const onlyRoma = lrcText.buildLrcText({ ...plainCandidate, rlyric })
const onlyRomaSegments = parseSegments(extractExtendedTag(onlyRoma))
check('只有罗马音：lrc + rlrc 两段', onlyRomaSegments.map(segment => segment.name), ['lrc', 'rlrc'])

const emptyTranslation = lrcText.buildLrcText({ ...plainCandidate, tlyric: '\n[by:x]\n[00:01.000]//\n', rlyric })
check('空翻译不写 tlrc 段', emptyTranslation.includes('tlrc:'), false)
check('空翻译时仍写 rlrc', parseSegments(extractExtendedTag(emptyTranslation)).map(segment => segment.name), ['lrc', 'rlrc'])

check('sanitizeExtendedLyric：CRLF/元信息/占位/空行清洗', lrcText.sanitizeExtendedLyric(tlyric), '[00:00.000]打上花火\n[00:04.500]那天看见的花的名字\n[00:08.250]我们仍未知晓')
check('sanitizeExtendedLyric：保留 [mm:ss] 无小数标签', lrcText.sanitizeExtendedLyric('[00:01]甲\n[00:02.5]乙\n[00:03.25]丙'), '[00:01]甲\n[00:02.5]乙\n[00:03.25]丙')
check('sanitizeExtendedLyric：丢弃非时间行', lrcText.sanitizeExtendedLyric('[ti:x]\n[ar:y]\n[al:z]\n[by:b]\n[offset:0]\n[kana:1]\n[language:ja]\n随便一行文字'), '')
check('sanitizeExtendedLyric：丢弃 // 与纯空白正文', lrcText.sanitizeExtendedLyric('[00:01.000]//\n[00:02.000]   \n[00:03.000]\n[00:04.000]正文'), '[00:04.000]正文')
check('sanitizeExtendedLyric：保持原顺序', lrcText.sanitizeExtendedLyric('[00:03.000]c\n[00:01.000]a\n[00:02.000]b'), '[00:03.000]c\n[00:01.000]a\n[00:02.000]b')
check('sanitizeExtendedLyric：空/空串返回空串', [lrcText.sanitizeExtendedLyric(''), lrcText.sanitizeExtendedLyric(null), lrcText.sanitizeExtendedLyric(undefined)], ['', '', ''])
check('sanitizeExtendedLyric：多时间标签行保留整行', lrcText.sanitizeExtendedLyric('[00:01.000][00:05.000]正文'), '[00:01.000][00:05.000]正文')

// ---------------------------------------------------------------- §3 预览

console.log('\n== §3 getLyricPreviewEntries：插行 / 上限 / 时间归一 ==')

const previewMain = '[ti:X]\n[offset:0]\n[00:01.50]A\n[00:02.00]B\n[00:03.000]C'
const previewTrans = '[00:01.500]甲\n[00:02.000]乙\n[00:03.000]丙'
const previewRoma = '[00:01.500]a\n[00:02.000]b'
const previewEntries = lrcText.getLyricPreviewEntries(previewMain, previewTrans, previewRoma)
check('插行顺序：主行 → 翻译 → 罗马音', previewEntries, [
  { text: '[00:01.50]A', type: 'main' },
  { text: '甲', type: 'translation' },
  { text: 'a', type: 'roma' },
  { text: '[00:02.00]B', type: 'main' },
  { text: '乙', type: 'translation' },
  { text: 'b', type: 'roma' },
  { text: '[00:03.000]C', type: 'main' },
  { text: '丙', type: 'translation' },
])
check('时间标签按毫秒归一：.5 == .500、.50 == .500', lrcText.getLyricPreviewEntries('[00:01.5]A\n[00:02.50]B', '[00:01.500]甲\n[00:02.500]乙'), [
  { text: '[00:01.5]A', type: 'main' },
  { text: '甲', type: 'translation' },
  { text: '[00:02.50]B', type: 'main' },
  { text: '乙', type: 'translation' },
])
check('最多 30 行（默认，含扩展行）', lrcText.getLyricPreviewEntries(previewMain, previewTrans, previewRoma, 30).length, 8)
check('maxLines 包含扩展行：3 行被截断', lrcText.getLyricPreviewEntries(previewMain, previewTrans, previewRoma, 3), [
  { text: '[00:01.50]A', type: 'main' },
  { text: '甲', type: 'translation' },
  { text: 'a', type: 'roma' },
])
check('maxLines = 2 时扩展行也要计入', lrcText.getLyricPreviewEntries(previewMain, previewTrans, previewRoma, 2).length, 2)
check('maxLines = 0 返回空', lrcText.getLyricPreviewEntries(previewMain, previewTrans, previewRoma, 0), [])
check('无对应翻译的行不插', lrcText.getLyricPreviewEntries('[00:01.000]A\n[00:02.000]B', '[00:01.000]甲'), [
  { text: '[00:01.000]A', type: 'main' },
  { text: '甲', type: 'translation' },
  { text: '[00:02.000]B', type: 'main' },
])
check('主行无时间标签时不插', lrcText.getLyricPreviewEntries('纯文本行\n[00:01.000]A', '[00:01.000]甲'), [
  { text: '纯文本行', type: 'main' },
  { text: '[00:01.000]A', type: 'main' },
  { text: '甲', type: 'translation' },
])
check('相同时间多行按同顺序配对', lrcText.getLyricPreviewEntries('[00:01.000]A1\n[00:01.000]A2', '[00:01.000]T1\n[00:01.000]T2'), [
  { text: '[00:01.000]A1', type: 'main' },
  { text: 'T1', type: 'translation' },
  { text: '[00:01.000]A2', type: 'main' },
  { text: 'T2', type: 'translation' },
])
check('翻译里的 // 与元信息不展示', lrcText.getLyricPreviewEntries('[00:01.000]A\n[00:02.000]B', '[by:x]\n[00:01.000]甲\n[00:02.000]//'), [
  { text: '[00:01.000]A', type: 'main' },
  { text: '甲', type: 'translation' },
  { text: '[00:02.000]B', type: 'main' },
])
check('空歌词返回空预览', lrcText.getLyricPreviewEntries('', tlyric, rlyric), [])
check('预览行数不超过 maxLines', lrcText.getLyricPreviewEntries(previewMain, previewTrans, previewRoma, 5).length, 5)
check('预览不包含 [awlrc:] 标签行', lrcText.getLyricPreviewEntries(extendedText).some(entry => entry.text.includes('awlrc')), false)

// ---------------------------------------------------------------- §4 netease provider

console.log('\n== §4 netease provider：搜索 / 取词 / 降级 ==')

resetHttp(() => jsonResponse({
  code: 200,
  result: {
    songs: [
      { id: 123, name: 'Song &amp; Dance', artists: [{ name: 'Artist' }, { name: 'Other' }], album: { name: 'Album' }, duration: 235000 },
      { id: 123, name: '同 id 重复项', artists: [], album: {}, duration: 1000 },
      { id: '456', name: 'Song (Inst_)', artists: [{ name: 'A' }], album: { name: '  ' }, duration: 'not-a-number' },
      { name: 'no id' },
    ],
  },
}))
const searchResult = await netease.search(makeQuery(['Song Artist', 'Song', 'extra']))
check('搜索映射：过滤无 id 并同 id 去重', searchResult.length, 2)
check('搜索映射：netease 字段完整', searchResult[0], {
  source: 'netease',
  id: '123',
  name: 'Song & Dance',
  singer: 'Artist / Other',
  albumName: 'Album',
  durationSec: 235,
  hasSynced: null,
  instrumental: false,
  score: 0,
})
check('搜索映射：HTML 实体/trim/伴奏标记/无效时长', searchResult[1], {
  source: 'netease',
  id: '456',
  name: 'Song (Inst_)',
  singer: 'A',
  albumName: '',
  durationSec: null,
  hasSynced: null,
  instrumental: true,
  score: 0,
})
check('关键词变体上限 2（只发 1 次即返回）', requestStub.requests.length, 1)
const searchUrl = new URL(requestStub.requests[0].url)
check('搜索 URL 参数', [searchUrl.searchParams.get('type'), searchUrl.searchParams.get('offset'), searchUrl.searchParams.get('limit'), searchUrl.searchParams.get('csrf_token')], ['1', '0', '10', ''])
check('搜索 URL 关键词', searchUrl.searchParams.get('s'), 'Song Artist')
check('搜索请求头：UA/Referer/Accept', [
  requestStub.requests[0].options.headers['User-Agent'].includes('Mozilla'),
  requestStub.requests[0].options.headers.Referer,
  requestStub.requests[0].options.headers.Accept,
], [true, 'https://music.163.com/', 'application/json'])
check('搜索请求头无 Cookie', Object.keys(requestStub.requests[0].options.headers).some(key => key.toLowerCase() === 'cookie'), false)
const searchLogs = parseLogs()
check('日志只记 source/cost/count（不含 URL/歌词）', searchLogs.every(line => !line.includes('http') && !line.includes('Song & Dance')), true)
check('日志包含 netease 来源与结果数', searchLogs.some(line => line.includes('netease') && line.includes('2 results')), true)

resetHttp(() => jsonResponse({ code: 200, result: { songs: [] } }))
const emptyKeywordWords = []
requestStub.setHttpHandler((record) => {
  emptyKeywordWords.push(searchKeyword(record))
  return jsonResponse({ code: 200, result: { songs: [] } })
})
check('关键词 0 条时继续下一个变体并最终返回空', await netease.search(makeQuery(['one', 'two', 'three'])), [])
check('变体最多请求 2 个', emptyKeywordWords, ['one', 'two'])

resetHttp((record) => {
  if (searchKeyword(record) === 'one') return searchResponse([])
  return searchResponse([{ id: 1, name: 'Found', artists: [], album: {}, duration: 1000 }])
})
const secondVariantResult = await netease.search(makeQuery(['one', 'two']))
check('第一个变体 0 条后使用第二个变体', [secondVariantResult.length, requestStub.requests.length], [1, 2])

resetHttp(() => jsonResponse({ code: 500, result: {} }))
await checkThrows('全部关键词 code!=200 时抛错', () => netease.search(makeQuery(['one', 'two'])), /code=500/)
check('code!=200 不当作成功', requestStub.requests.length, 2)

resetHttp((record) => {
  if (searchKeyword(record) === 'one') return jsonResponse({ code: 500 })
  return searchResponse([{ id: 1, name: 'Found', artists: [], album: {}, duration: 1000 }])
})
check('第一个变体 code!=200 后降级到第二个变体', (await netease.search(makeQuery(['one', 'two']))).length, 1)

resetHttp(() => ({ statusCode: 502, body: 'bad gateway' }))
await checkThrows('HTTP 状态非 2xx 视为失败并抛错', () => netease.search(makeQuery(['one', 'two'])), /HTTP 502/)

resetHttp((record) => {
  if (searchKeyword(record) === 'one') return { statusCode: 500, body: {} }
  return { statusCode: 200, body: JSON.stringify({ code: 200, result: { songs: [{ id: 9, name: 'StringBody', artists: [{ name: 'S' }], album: { name: 'A' }, duration: 1000 }] } }) }
})
check('字符串 JSON body 也能解析 + HTTP 失败降级', (await netease.search(makeQuery(['one', 'two'])))[0].name, 'StringBody')

resetHttp(() => ({ statusCode: 200, body: 'x'.repeat(4 * 1024 * 1024 + 1) }))
await checkThrows('响应体超过 4MB 视为失败', () => netease.search(makeQuery(['one'])), /too large/)

resetHttp(() => searchResponse([]))
const abortedController = new AbortController()
abortedController.abort()
check('signal 已中止时搜索直接返回空', await netease.search(makeQuery(['one']), abortedController.signal), [])
check('signal 已中止时不发请求', requestStub.requests.length, 0)
check('空 variants 不发请求返回空', await netease.search(makeQuery([])), [])

// ---- 取词

const lyricResponseBody = {
  code: 200,
  lrc: { lyric: '[00:00.000]打上花火\n[00:04.500]あの日見た花の名前を\n[00:08.250]僕たちはまだ知らない' },
  tlyric: { lyric: '[by:Translation]\n[00:00.000]打上花火\n[00:04.500]那天看见的花的名字\n[00:08.250]我们仍未知晓\n[00:10.000]//' },
  romalrc: { lyric: '[00:00.000]uchiage hanabi\n[00:04.500]ano hi mita hana no namae wo' },
}

resetHttp(() => jsonResponse(lyricResponseBody))
const lyricResult = await netease.getLyric(makeCandidate())
check('取词：主歌词 + isSynced', [lyricResult.lyric.includes('[00:04.500]あの日見た花の名前を'), lyricResult.isSynced], [true, true])
check('取词：翻译清洗（去 [by:]/`//`）', lyricResult.tlyric, '[00:00.000]打上花火\n[00:04.500]那天看见的花的名字\n[00:08.250]我们仍未知晓')
check('取词：罗马音', lyricResult.rlyric, '[00:00.000]uchiage hanabi\n[00:04.500]ano hi mita hana no namae wo')
const lyricUrl = new URL(requestStub.requests[0].url)
check('取词 URL 参数', [lyricUrl.searchParams.get('id'), lyricUrl.searchParams.get('lv'), lyricUrl.searchParams.get('kv'), lyricUrl.searchParams.get('tv'), lyricUrl.searchParams.get('rv')], ['123', '-1', '-1', '-1', '-1'])
check('取词请求无 Cookie', Object.keys(requestStub.requests[0].options.headers).some(key => key.toLowerCase() === 'cookie'), false)
check('取词日志不含歌词正文', parseLogs().every(line => !line.includes('打上花火') && !line.includes('http')), true)

resetHttp(() => jsonResponse({
  code: 200,
  lrc: { lyric: '[00:00.000]main lyric text long enough' },
  romalrc: { lyric: '' },
  yromalrc: { lyric: '[00:00.000]yromalrc line' },
}))
check('romalrc 为空时回退 yromalrc', (await netease.getLyric(makeCandidate())).rlyric, '[00:00.000]yromalrc line')

resetHttp(() => jsonResponse({
  code: 200,
  lrc: { lyric: '[00:00.000]main lyric text long enough' },
  yromalrc: { lyric: '[00:00.000]only yromalrc' },
}))
check('romalrc 缺失时使用 yromalrc', (await netease.getLyric(makeCandidate())).rlyric, '[00:00.000]only yromalrc')

resetHttp(() => jsonResponse({ code: 200, lrc: { lyric: '[00:00.000]main lyric text long enough' } }))
const noExtended = await netease.getLyric(makeCandidate())
check('无翻译/罗马音时返回空串', [noExtended.tlyric, noExtended.rlyric], ['', ''])

resetHttp(() => jsonResponse({ code: 200, nolyric: true }))
check('nolyric 返回 null', await netease.getLyric(makeCandidate()), null)
resetHttp(() => jsonResponse({ code: 200, uncollected: true }))
check('uncollected 返回 null', await netease.getLyric(makeCandidate()), null)
resetHttp(() => jsonResponse({ code: 404 }))
check('取词 code!=200 返回 null', await netease.getLyric(makeCandidate()), null)
resetHttp(() => jsonResponse({ code: 200, tlyric: { lyric: '[00:01.000]只有翻译' } }))
check('只有翻译没有主歌词返回 null', await netease.getLyric(makeCandidate()), null)
resetHttp(() => jsonResponse({ code: 200, lrc: { lyric: '[00:00.000]未经许可,不得翻唱或使用\n[00:05.000]请购买正版' }, tlyric: { lyric: '[00:01.000]翻译' } }))
check('占位文本返回 null', await netease.getLyric(makeCandidate()), null)
resetHttp(() => jsonResponse({ code: 200, lrc: { lyric: '[00:00.000]短' } }))
check('过短歌词返回 null', await netease.getLyric(makeCandidate()), null)
resetHttp(() => { throw new Error('network down') })
check('网络失败返回 null 不抛出', await netease.getLyric(makeCandidate()), null)
resetHttp(() => jsonResponse(lyricResponseBody))
check('signal 已中止时取词直接返回 null', await netease.getLyric(makeCandidate(), abortedController.signal), null)
check('signal 已中止时不发取词请求', requestStub.requests.length, 0)

// ---------------------------------------------------------------- §5 parseLyric 回读

console.log('\n== §5 parseLyric：扩展段回读 tlyric/rlyric ==')

const writtenText = lrcText.buildLrcText({
  name: '打上花火',
  singer: 'DAOKO / 米津玄師',
  albumName: '',
  lyric: mainLyric,
  isSynced: true,
  tlyric,
  rlyric,
})
const parsed = parseLyric(writtenText)
check('回读主歌词（含正文行）', parsed.lyric.includes('[00:00.000]打上花火') && parsed.lyric.includes('[00:08.250]僕たちはまだ知らない'), true)
check('回读后不再残留 [awlrc:] 标签', parsed.lyric.includes('[awlrc:'), false)
check('回读翻译', parsed.tlyric, '[00:00.000]打上花火\n[00:04.500]那天看见的花的名字\n[00:08.250]我们仍未知晓')
check('回读罗马音', parsed.rlyric, rlyric)

const noExtendedText = lrcText.buildLrcText(plainCandidate)
const parsedNoExtended = parseLyric(noExtendedText)
check('无扩展段时回读无 tlyric/rlyric', [parsedNoExtended.tlyric, parsedNoExtended.rlyric], [undefined, undefined])
check('无扩展段时正文不变', parsedNoExtended.lyric, noExtendedText.trim())

const translationOnlyText = lrcText.buildLrcText({ ...plainCandidate, tlyric })
const parsedTranslationOnly = parseLyric(translationOnlyText)
check('只有翻译的扩展段可回读', [parsedTranslationOnly.tlyric, parsedTranslationOnly.rlyric], ['[00:00.000]打上花火\n[00:04.500]那天看见的花的名字\n[00:08.250]我们仍未知晓', undefined])

const mixedTimeCandidate = {
  ...plainCandidate,
  lyric: '[00:01.00]作词\n[00:20:49][00:24:03]日文\n[00:30]尾声 [00:40:00]',
  tlyric: '[00:20:49]中文\n[00:24:03]中文',
  rlyric: '[00:20.490]nihongo\n[00:24.030]nihongo',
}
const mixedTimeLyric = parseLyric(lrcText.buildLrcText(mixedTimeCandidate))
const playerLyric = new Lyric({})
playerLyric.setLyric(mixedTimeLyric.lyric, [mixedTimeLyric.tlyric, mixedTimeLyric.rlyric].filter(Boolean))
check('回读旧外挂歌词后，播放器按毫秒对齐冒号时间戳、中文翻译和罗马音', playerLyric.lines, [
  { time: 1000, text: '作词', extendedLyrics: [] },
  { time: 20490, text: '日文', extendedLyrics: ['中文', 'nihongo'] },
  { time: 24030, text: '日文', extendedLyrics: ['中文', 'nihongo'] },
  { time: 30000, text: '尾声 [00:40:00]', extendedLyrics: [] },
])
const plainMixedTimeLyric = parseLyric(lrcText.buildLrcText({ ...mixedTimeCandidate, tlyric: '', rlyric: '' }))
check('无扩展段的外挂歌词也转换行首时间戳', plainMixedTimeLyric.lyric, mixedTimeLyric.lyric)

// 暂停时只更新解析出的行，测试环境无需播放计时器。
fs.writeFileSync(path.join(moduleDir, 'reactHooks.ts'), `
export const useEffect = () => {}
export const useState = value => [value, () => {}]
`, 'utf8')
fs.writeFileSync(path.join(moduleDir, 'lyricPlugin.ts'), readSrc('plugins/lyric.ts')
  .replace("from 'react'", "from './reactHooks.ts'")
  .replace("from 'lrc-file-parser'", `from '${import.meta.resolve('lrc-file-parser')}'`), 'utf8')
const lyricPlugin = await load('lyricPlugin')
await lyricPlugin.init()
lyricPlugin.setLyric('[offset:50]\n[00:10.000]first\n[00:20.000]second\n[00:30.000]last')
lyricPlugin.seekPaused(20300)
check('暂停定位选择当前歌词', lyricPlugin.useLrcPlay(false), { line: 1, text: 'second' })
lyricPlugin.seekPaused(19850)
check('暂停定位应用文件和播放器偏移', lyricPlugin.useLrcPlay(false), { line: 1, text: 'second' })
lyricPlugin.seekPaused(19849)
check('可向前定位回上一句', lyricPlugin.useLrcPlay(false), { line: 0, text: 'first' })
lyricPlugin.seekPaused(40000)
check('暂停定位超过末尾时使用末行', lyricPlugin.useLrcPlay(false), { line: 2, text: 'last' })
lyricPlugin.setLyric('')
lyricPlugin.seekPaused(10000)
check('无歌词时暂停定位为空', lyricPlugin.useLrcPlay(false).text, '')

// ---------------------------------------------------------------- §6 接线静态检查

console.log('\n== §6 接线：provider/超时/类型/默认值/i18n ==')

const indexSource = readSrc('core/mediaMatch/index.ts')
check('编排 provider 顺序 lrclib → qq → netease', /const providers: LyricsProvider\[\] = \[lrclib, qq, netease]/.test(indexSource), true)
check('三源并行搜索', /Promise\.all\(providers\.map/.test(indexSource), true)
check('整体兜底超时 12s', /const OVERALL_TIMEOUT = 12000/.test(indexSource), true)
check('单源预算 8s', /const SOURCE_TIMEOUT = 8000/.test(indexSource), true)
check('候选为空且有源失败时抛错（不再静默空）', /failedCount > 0\) throw new Error/.test(indexSource), true)
check('getCandidateLyric 返回 LyricResult', /getCandidateLyric = async\(candidate: LX\.Music\.LyricsCandidate, signal\?: AbortSignal\): Promise<LX\.Music\.LyricResult \| null>/.test(indexSource), true)
check('applyLrcToMusic 传递 tlyric/rlyric', /tlyric: result\.tlyric,\s*\r?\n\s*rlyric: result\.rlyric,/.test(indexSource), true)

const typesSource = readSrc('types/music.d.ts')
check('LyricsSource 增加 netease', /type LyricsSource = 'lrclib' \| 'qq' \| 'netease'/.test(typesSource), true)
check('LyricResult 类型含 tlyric/rlyric', /interface LyricResult \{[\s\S]*?tlyric\?: string[\s\S]*?rlyric\?: string/.test(typesSource), true)
check('LyricsCandidate 有 hasTranslation/hasRomaji', /hasTranslation\?: boolean[\s\S]*?hasRomaji\?: boolean/.test(typesSource), true)

const defaultSettingSource = readSrc('config/defaultSetting.ts')
check('默认配置 version 2.1', /version: '2\.1'/.test(defaultSettingSource), true)
check('默认打开翻译', /'player\.isShowLyricTranslation': true/.test(defaultSettingSource), true)
check('罗马音默认仍关', /'player\.isShowLyricRoma': false/.test(defaultSettingSource), true)

const migrateSource = readSrc('config/migrateSetting.ts')
check('迁移追加 <2.1 块', /compareVer\(setting\.version as string, '2\.1'\) < 0/.test(migrateSource), true)
check('迁移强制翻译 true 并写 version', /setting\['player\.isShowLyricTranslation'\] = true[\s\S]*?setting\.version = '2\.1'/.test(migrateSource), true)

const modalSource = readSrc('components/LyricsMatchModal/index.tsx')
check('弹窗预览使用 getLyricPreviewEntries', modalSource.includes('getLyricPreviewEntries('), true)
check('扩展行 size=11（主行 12）', /size=\{entry\.type === 'main' \? 12 : 11\}/.test(modalSource), true)
check('弹窗传递 tlyric/rlyric 取词结果', /tlyric: result\.tlyric, rlyric: result\.rlyric/.test(modalSource), true)
check('弹窗展示含翻译/含罗马音标签', modalSource.includes('lyrics_match_translation_available') && modalSource.includes('lyrics_match_roma_available'), true)

const candidateItemSource = readSrc('components/LyricsMatchModal/CandidateItem.tsx')
check('候选来源标签识别 netease', candidateItemSource.includes("lyrics_match_source_netease"), true)

const newLangKeys = ['lyrics_match_source_netease', 'lyrics_match_translation_available', 'lyrics_match_roma_available']
for (const file of ['zh-cn.json', 'zh-tw.json', 'en-us.json']) {
  const dict = JSON.parse(readSrc(`lang/${file}`))
  const emptyKeys = newLangKeys.filter(key => typeof dict[key] !== 'string' || !dict[key].trim())
  check(`语言包 ${file} 三个新 key 齐全且非空`, emptyKeys, [])
}

// ---------------------------------------------------------------- 汇总

console.log(`\nresult: ${passed} passed, ${failed} failed`)
if (failed) {
  console.log(`failed cases:\n  - ${failures.join('\n  - ')}`)
  process.exitCode = 1
}
