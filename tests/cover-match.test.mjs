/**
 * 移动端 Phase 3：封面匹配纯逻辑 + 文件规则测试
 *
 * 运行：node tests/cover-match.test.mjs
 *
 * 做法（与桌面 tests/cover-match.test.ts 同一套路）：
 * 1. 把真实 TS 源码（image/score/normalize/query/localPathCheck/lrcFile/coverFile）复制到临时目录，
 *    把 `@/...` 别名与无扩展名的相对导入改写为带 `.ts` 的本地导入；
 * 2. 用 node:fs 写一个 `@/utils/fs` 替身（含 temporaryDirectoryPath/privateDirectory 常量、
 *    RN FileSystem.rename(path, name) 的同目录改名语义、ENOSPC/EPERM 故障注入）；
 * 3. 用虚拟 POSIX 路径（/work/...、/app/cache）驱动真实 coverFile.ts，避免 Windows 盘符影响路径判定；
 * 4. 覆盖契约 §4 A1/A3/A4：图片 magic/尺寸/体积、评分/去重/排序、路径四类、
 *    首次写/覆盖/跨扩展名/写入失败/删除/非法输入/无 tmp 残留/音频不变。
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

const checkThrowsCode = async(name, fn, expectedCode) => {
  try {
    await fn()
    failed++
    failures.push(name)
    console.log(`  FAIL ${name} (no throw)`)
  } catch (err) {
    const code = err?.code
    if (code === expectedCode) {
      passed++
      console.log(`  ok   ${name}`)
    } else {
      failed++
      failures.push(name)
      console.log(`  FAIL ${name}\n       code = ${code}\n       expected = ${expectedCode}`)
    }
  }
}

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url))
const moduleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-mobile-cover-match-'))
const realRoot = path.join(moduleDir, 'vfs')
fs.mkdirSync(realRoot, { recursive: true })

const copyModule = (relPath, destName = path.basename(relPath)) => {
  const code = fs.readFileSync(path.join(sourceRoot, relPath), 'utf8')
    .replace(/(['"])@\/utils\/mediaMatch\/normalize\1/g, "'./normalize.ts'")
    .replace(/(['"])@\/utils\/mediaMatch\/query\1/g, "'./query.ts'")
    .replace(/(['"])@\/utils\/coverMatch\/image\1/g, "'./image.ts'")
    .replace(/(['"])@\/utils\/localPathCheck\1/g, "'./localPathCheck.ts'")
    .replace(/(['"])@\/utils\/fs\1/g, "'./fs.ts'")
    .replace(/(['"])@\/utils\/log\1/g, "'./log.ts'")
    .replace(/from '\.\/([A-Za-z0-9_]+)'/g, "from './$1.ts'")
  fs.writeFileSync(path.join(moduleDir, destName), code, 'utf8')
}

copyModule('utils/mediaMatch/normalize.ts')
copyModule('utils/mediaMatch/query.ts')
copyModule('utils/coverMatch/image.ts')
copyModule('utils/coverMatch/score.ts')
copyModule('utils/localPathCheck.ts')
copyModule('utils/sidecarWrite.ts')
copyModule('utils/lrcFile.ts')
copyModule('utils/coverFile.ts')

// node:fs 版的 @/utils/fs（虚拟 POSIX 路径 → 临时目录下的真实文件）
const fsShimCode = `
import fs from 'node:fs'
import path from 'node:path'

const root = ${JSON.stringify(realRoot)}

export const temporaryDirectoryPath = '/app/cache'
export const privateStorageDirectoryPath = '/app/private'

/** 故障注入钩子：返回 Error 则抛出，返回 null/undefined 正常执行 */
export const failureHooks = {
  writeFile: null,
  readFile: null,
  rename: null,
  unlink: null,
  renameNoOverwrite: false,
}

const toReal = (virtualPath) => path.join(root, virtualPath.slice(1))

const ensureDir = (virtualPath) => {
  fs.mkdirSync(path.dirname(toReal(virtualPath)), { recursive: true })
}

const throwIfInjected = (hook, op) => {
  const err = hook?.(op)
  if (err) throw err
}

export const existsFile = async (virtualPath) => fs.existsSync(toReal(virtualPath))

export const stat = async (virtualPath) => {
  const info = await fs.promises.stat(toReal(virtualPath))
  return {
    name: path.basename(virtualPath),
    path: virtualPath,
    isDirectory: info.isDirectory(),
    isFile: info.isFile(),
    size: info.size,
    lastModified: info.mtimeMs,
  }
}

export const rename = async (virtualPath, name) => {
  throwIfInjected(failureHooks.rename, { path: virtualPath, name })
  const target = path.posix.join(path.posix.dirname(virtualPath), name)
  if (failureHooks.renameNoOverwrite && fs.existsSync(toReal(target))) return false
  await fs.promises.rename(toReal(virtualPath), toReal(target))
  return true
}

export const writeFile = async (virtualPath, data, encoding) => {
  throwIfInjected(failureHooks.writeFile, { path: virtualPath, encoding })
  ensureDir(virtualPath)
  const content = encoding === 'base64' ? Buffer.from(data, 'base64') : data
  await fs.promises.writeFile(toReal(virtualPath), content)
}

export const readFile = async (virtualPath, encoding) => {
  throwIfInjected(failureHooks.readFile, { path: virtualPath, encoding })
  const content = await fs.promises.readFile(toReal(virtualPath))
  return encoding === 'base64' ? content.toString('base64') : content.toString('utf8')
}

export const unlink = async (virtualPath) => {
  throwIfInjected(failureHooks.unlink, { path: virtualPath })
  await fs.promises.unlink(toReal(virtualPath))
  return true
}

export const copyFile = async (fromPath, toPath) => {
  ensureDir(toPath)
  await fs.promises.copyFile(toReal(fromPath), toReal(toPath))
}
`
fs.writeFileSync(path.join(moduleDir, 'fs.ts'), fsShimCode, 'utf8')

fs.writeFileSync(path.join(moduleDir, 'log.ts'), `
export const logs = []

export const log = {
  info: (...args) => { logs.push(['info', ...args]) },
  warn: (...args) => { logs.push(['warn', ...args]) },
  error: (...args) => { logs.push(['error', ...args]) },
}
`, 'utf8')

const load = async(name) => import(pathToFileURL(path.join(moduleDir, `${name}.ts`)).href)

const image = await load('image')
const score = await load('score')
const localPathCheck = await load('localPathCheck')
const lrcFile = await load('lrcFile')
const coverFile = await load('coverFile')
const fsShim = await load('fs')

const realOf = virtualPath => path.join(realRoot, virtualPath.slice(1))

const resetDir = virtualDir => {
  fs.rmSync(realOf(virtualDir), { recursive: true, force: true })
  fs.mkdirSync(realOf(virtualDir), { recursive: true })
}

const makeErr = (code, message) => {
  const err = new Error(message ?? code)
  err.code = code
  return err
}

const withHook = async(hookName, hook, fn) => {
  fsShim.failureHooks[hookName] = hook
  try {
    return await fn()
  } finally {
    fsShim.failureHooks[hookName] = null
  }
}

// 构造最小合法 JPEG（含 APP0 + SOF0），宽高可指定
const makeJpeg = (width, height, tag = 0) => {
  const app0Payload = Buffer.alloc(14)
  app0Payload[0] = tag & 0xff
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), app0Payload])
  const sof = Buffer.from([
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03,
    0x01, 0x11, 0x00,
    0x02, 0x11, 0x01,
    0x03, 0x11, 0x01,
  ])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])])
}

// 构造最小合法 PNG（签名 + IHDR），宽高可指定
const makePng = (width, height, tag = 0) => {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4, 'ascii')
  ihdr.writeUInt32BE(width, 8)
  ihdr.writeUInt32BE(height, 12)
  ihdr[16] = 8
  ihdr[17] = 6
  ihdr[18] = tag & 0xff
  return Buffer.concat([signature, ihdr])
}

console.log('\n== A1 image：magic / 尺寸 / 体积 ==')
check('MAX_IMAGE_BYTES = 8MB', image.MAX_IMAGE_BYTES, 8 * 1024 * 1024)
check('尺寸上下限常量', [image.MIN_IMAGE_DIMENSION, image.MAX_IMAGE_DIMENSION], [200, 4000])
check('JPEG magic + 尺寸', image.parseImageInfo(makeJpeg(500, 500)), { format: 'jpg', width: 500, height: 500 })
check('PNG magic + 尺寸', image.parseImageInfo(makePng(600, 600)), { format: 'png', width: 600, height: 600 })
check('未知格式返回 null', image.parseImageInfo(Buffer.from('not-an-image')), null)
check('webp 返回 null', image.parseImageInfo(Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 ', 'binary')), null)
check('GIF 返回 null', image.parseImageInfo(Buffer.from('GIF89a\x01\x00\x01\x00', 'binary')), null)
check('PNG 签名长度不足返回 null', image.parseImageInfo(makePng(600, 600).subarray(0, 12)), null)
check('PNG 23 字节截断返回 null', image.parseImageInfo(makePng(600, 600).subarray(0, 23)), null)
check('JPEG 截断返回 null', image.parseImageInfo(makeJpeg(500, 500).subarray(0, 8)), null)
check('JPEG 无 SOF 返回 null', image.parseImageInfo(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), null)
check('空数据返回 null', image.parseImageInfo(new Uint8Array(0)), null)
check('尺寸下限 200 合法', image.isImageSizeAllowed(200, 200), true)
check('尺寸上限 4000 合法', image.isImageSizeAllowed(4000, 4000), true)
check('宽 199 非法', image.isImageSizeAllowed(199, 500), false)
check('高 199 非法', image.isImageSizeAllowed(500, 199), false)
check('宽 4001 非法', image.isImageSizeAllowed(4001, 500), false)
check('高 4001 非法', image.isImageSizeAllowed(500, 4001), false)
check('尺寸 200 边界 JPEG 通过', image.validateImageData(makeJpeg(200, 200)), { format: 'jpg', width: 200, height: 200 })
check('尺寸 4000 边界 PNG 通过', image.validateImageData(makePng(4000, 4000)), { format: 'png', width: 4000, height: 4000 })
await checkThrowsCode('199px 图片拒绝（image_invalid）', () => image.validateImageData(makeJpeg(199, 500)), 'image_invalid')
await checkThrowsCode('4001px 图片拒绝（image_invalid）', () => image.validateImageData(makePng(4001, 500)), 'image_invalid')
await checkThrowsCode('空数据拒绝（image_invalid）', () => image.validateImageData(new Uint8Array(0)), 'image_invalid')
await checkThrowsCode('webp 拒绝（image_invalid）', () => image.validateImageData(Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 ', 'binary')), 'image_invalid')
const tooLargeData = Buffer.alloc(image.MAX_IMAGE_BYTES + 1)
tooLargeData[0] = 0xff
tooLargeData[1] = 0xd8
tooLargeData[2] = 0xff
await checkThrowsCode('超过 8MB 拒绝（image_too_large）', () => image.validateImageData(tooLargeData), 'image_too_large')
check('CoverImageError 可识别', (() => {
  try {
    image.validateImageData(new Uint8Array(0))
    return false
  } catch (err) {
    return err instanceof image.CoverImageError && err instanceof Error && err.code === 'image_invalid'
  }
})(), true)

console.log('\n== A2 score：权重 / 专辑加分 / 伴奏惩罚 / 去重 / 排序 ==')
const query = {
  name: 'Song',
  singer: 'Artist',
  albumName: 'Album',
  durationSec: 235,
  fileStem: 'Artist - Song',
  variants: ['Song Artist', 'Song'],
}
const candidate = (overrides = {}) => ({
  source: 'qq',
  id: 'album-1',
  name: 'Song',
  singer: 'Artist',
  albumName: 'Album',
  durationSec: 235,
  coverUrl: 'https://y.qq.com/music/photo_new/T002R500x500M000album-1.jpg',
  thumbnailUrl: 'https://y.qq.com/music/photo_new/T002R150x150M000album-1.jpg',
  score: 0,
  ...overrides,
})

check('titleScore 完全相同 = 1', score.titleScore('Song', 'Song'), 1)
check('titleScore 包含 = 0.85', score.titleScore('Song', 'Song (Live)'), 0.85)
check('titleScore 空串 = 0', score.titleScore('', 'Song'), 0)
check('artistScore 相同 = 1', score.artistScore('Artist', 'Artist'), 1)
check('artistScore 缺失给中性 0.5', score.artistScore('Artist', ''), 0.5)
check('artistScore 多歌手取最大', score.artistScore('A / B', 'B'), 1)
check('durationScore 缺一方 = 0.5', score.durationScore(null, 235), 0.5)
check('durationScore ±2s = 1', score.durationScore(235, 237), 1)
check('durationScore ±5s = 0.8', score.durationScore(235, 240), 0.8)
check('durationScore ±10s = 0.5', score.durationScore(235, 245), 0.5)
check('durationScore >10s = 0.1', score.durationScore(235, 246), 0.1)
check('albumBonus 相同 +0.05', score.albumBonus('Album', 'Album'), 0.05)
check('albumBonus 包含 +0.05', score.albumBonus('Album (Deluxe Edition)', 'Album'), 0.05)
check('albumBonus 不同 = 0', score.albumBonus('Album', 'Other'), 0)
check('albumBonus 空值 = 0', score.albumBonus('', 'Album'), 0)
check('isInstrumentalQuery 识别括号标记', score.isInstrumentalQuery({ ...query, name: 'Song (Off Vocal)' }), true)
check('isInstrumentalQuery 识别文件名标记', score.isInstrumentalQuery({ ...query, fileStem: 'Song (Inst_)' }), true)
check('isInstrumentalQuery 普通歌名 = false', score.isInstrumentalQuery(query), false)
check('完全一致且专辑相同 = 1（封顶）', score.scoreCoverCandidate(query, candidate()), 1)
check('专辑相同 +0.05', score.scoreCoverCandidate(query, candidate({ singer: 'Other' })), 0.75)
check('专辑不同不加分', score.scoreCoverCandidate(query, candidate({ singer: 'Other', albumName: 'Different' })), 0.7)
check(
  '专辑包含 +0.05',
  score.scoreCoverCandidate({ ...query, albumName: 'Album (Deluxe Edition)' }, candidate({ singer: 'Other' })),
  0.75,
)
check('本地专辑为空不加分', score.scoreCoverCandidate({ ...query, albumName: '' }, candidate({ singer: 'Other' })), 0.7)
check('候选标题带伴奏标记 → 减半', score.scoreCoverCandidate(query, candidate({ name: 'Song (Off Vocal)' })), 0.4875)
check(
  '查询本身带伴奏标记时不扣分',
  score.scoreCoverCandidate(
    { ...query, name: 'Song (Off Vocal)', fileStem: 'Artist - Song (Off Vocal)' },
    candidate({ name: 'Song (Off Vocal)' }),
  ),
  1,
)
check('分数保留 4 位小数', score.scoreCoverCandidate(query, candidate({ name: 'Sung', singer: '', durationSec: null, albumName: 'X' })), 0.3833)
check('去重键 source:id', score.getCoverDedupeKey(candidate({ source: 'itunes', id: 'x' })), 'itunes:x')

const merged = score.mergeCoverCandidates([
  candidate({ id: 'same', score: 0.4 }),
  candidate({ id: 'same', score: 0.8 }),
  candidate({ id: 'other', score: 0.5 }),
])
check('专辑维度去重（source+id）', merged.length, 2)
check('去重保留分数最高者', merged.find(item => item.id === 'same').score, 0.8)

const ranked = score.rankCoverCandidates(query, [
  candidate({ id: 'same', name: 'Song (Off Vocal)' }),
  candidate({ id: 'same', name: 'Song' }),
  candidate({ id: 'other', name: 'Different Song', singer: 'Other', albumName: 'Other' }),
])
check('评分后专辑维度去重', ranked.length, 2)
check('去重保留最高分候选的曲名', ranked[0].name, 'Song')
check('按分数降序', ranked[0].score >= ranked[1].score, true)
const crossSource = score.rankCoverCandidates(query, [
  candidate({ source: 'qq', id: 'x' }),
  candidate({ source: 'itunes', id: 'x' }),
])
check('不同源同 id 不去重', crossSource.length, 2)
const many = Array.from({ length: 25 }, (_, i) => candidate({ id: String(i), name: `Song ${i}` }))
check('最多返回 20 条', score.rankCoverCandidates(query, many).length, 20)
check('limit 参数生效', score.rankCoverCandidates(query, many, 3).length, 3)

console.log('\n== A3 路径判定：checkWritableLocalPath / checkLrcMatchablePath 行为一致 ==')
const pathCases = [
  [undefined, 'invalid'],
  [null, 'invalid'],
  ['', 'invalid'],
  ['Music/a.mp3', 'invalid'],
  ['content://media/external/audio/1', 'uri'],
  ['file:///storage/emulated/0/Music/a.mp3', 'uri'],
  ['/storage/emulated/0/Music/a.mp3', 'ok'],
  ['/app/cache', 'app_private'],
  ['/app/cache/', 'app_private'],
  ['/app/cache/a.mp3', 'app_private'],
  ['/app/private/a.mp3', 'app_private'],
  ['/app/privatex/a.mp3', 'ok'],
  ['/app/cachex/a.mp3', 'ok'],
]
for (const [input, expected] of pathCases) {
  check(`checkWritableLocalPath(${JSON.stringify(input)}) = ${expected}`, localPathCheck.checkWritableLocalPath(input), expected)
}
for (const [input, expected] of pathCases) {
  check(`checkLrcMatchablePath(${JSON.stringify(input)}) 行为不变 = ${expected}`, lrcFile.checkLrcMatchablePath(input), expected)
}
for (const [input, expected] of pathCases) {
  check(`checkCoverMatchablePath(${JSON.stringify(input)}) = ${expected}`, coverFile.checkCoverMatchablePath(input), expected)
}
check('checkWritableLocalPath 支持注入目录', localPathCheck.checkWritableLocalPath('/custom/cache/a.mp3', { temporaryDirectoryPath: '/custom/cache' }), 'app_private')
check('checkWritableLocalPath 注入私有目录', localPathCheck.checkWritableLocalPath('/custom/private/a.mp3', { privateStorageDirectoryPath: '/custom/private' }), 'app_private')
check('lrcFile 其余导出仍在', typeof lrcFile.writeLrcFile === 'function' && typeof lrcFile.getLrcFilePath === 'function', true)

console.log('\n== A4 coverFile：同名图路径 / 状态 / 首次写入 ==')
const firstDir = '/work/first'
resetDir(firstDir)
const audioPath = `${firstDir}/Artist - Song.flac`
const audioContent = 'fake-audio-content'
await fsShim.writeFile(audioPath, audioContent)
const audioBase64Before = await fsShim.readFile(audioPath, 'base64')
const audioMtimeBefore = (await fsShim.stat(audioPath)).lastModified
const jpgPath = `${firstDir}/Artist - Song.jpg`
const pngPath = `${firstDir}/Artist - Song.png`
const jpgBackupPath = `${jpgPath}.bak`
const pngBackupPath = `${pngPath}.bak`

check('getImagePath（音频扩展名剥离）', coverFile.getImagePath(audioPath, 'jpg'), jpgPath)
check('getImagePath（无扩展名）', coverFile.getImagePath(`${firstDir}/NoExt`, 'png'), `${firstDir}/NoExt.png`)
check('isAudioFilePath 真实音频 = true', await coverFile.isAudioFilePath(audioPath), true)
check('isAudioFilePath 不存在 = false', await coverFile.isAudioFilePath(`${firstDir}/missing.mp3`), false)
check('isAudioFilePath 相对路径 = false', await coverFile.isAudioFilePath('Artist - Song.flac'), false)
await fsShim.writeFile(`${firstDir}/song.lrc`, 'lrc')
check('isAudioFilePath .lrc = false', await coverFile.isAudioFilePath(`${firstDir}/song.lrc`), false)
await fsShim.writeFile(`${firstDir}/pic.jpg`, 'jpg')
check('isAudioFilePath .jpg = false', await coverFile.isAudioFilePath(`${firstDir}/pic.jpg`), false)
await fsShim.writeFile(`${firstDir}/Upper.MP3`, 'upper-audio')
check('isAudioFilePath 其它音频扩展名 = true', await coverFile.isAudioFilePath(`${firstDir}/Upper.MP3`), true)
check('初始无同名图', await coverFile.getCoverImagePathIfExists(audioPath), null)
check('无效路径状态为空', await coverFile.getCoverState(`${firstDir}/missing.mp3`), { imageExists: false })

const firstJpeg = makeJpeg(500, 500, 1)
const firstApply = await coverFile.applyCoverImage(audioPath, firstJpeg)
await checkThrowsCode('批量模式保留已有封面', () => coverFile.applyCoverImage(audioPath, firstJpeg, true), 'already_exists')
check('首次写入 JPEG → 同名 .jpg', firstApply, { imagePath: jpgPath, format: 'jpg' })
check('首次写入不产生备份', await fsShim.existsFile(jpgBackupPath), false)
check('首次写入内容正确', await fsShim.readFile(jpgPath, 'base64'), firstJpeg.toString('base64'))
check('首次写入无 tmp 残留', fs.readdirSync(realOf(firstDir)).filter(name => name.endsWith('.tmp')), [])
const imagePathInfo = await coverFile.getCoverImagePathIfExists(audioPath)
check('getCoverImagePathIfExists 返回 jpg', imagePathInfo?.path, jpgPath)
check('getCoverImagePathIfExists 返回格式', imagePathInfo?.format, 'jpg')
check('getCoverImagePathIfExists 返回 mtime 数字', typeof imagePathInfo?.mtime, 'number')
const stateAfterFirst = await coverFile.getCoverState(audioPath)
check('状态：图片存在', stateAfterFirst.imageExists, true)
check('状态：格式 jpg', stateAfterFirst.imageFormat, 'jpg')
check('状态：图片路径', stateAfterFirst.imagePath, jpgPath)
check('状态：图片体积', stateAfterFirst.imageSize, firstJpeg.length)
check('状态：mtime 数字', typeof stateAfterFirst.imageMtime, 'number')
check('首次写入后音频内容未变', await fsShim.readFile(audioPath, 'base64'), audioBase64Before)
check('首次写入后音频 mtime 未变', (await fsShim.stat(audioPath)).lastModified, audioMtimeBefore)

console.log('\n== 同名封面覆盖和删除 ==')
const secondJpeg = makeJpeg(600, 600, 2)
await coverFile.applyCoverImage(audioPath, secondJpeg)
check('覆盖同名 JPEG', await fsShim.readFile(jpgPath, 'base64'), secondJpeg.toString('base64'))
check('覆盖不产生备份', await fsShim.existsFile(jpgBackupPath), false)

const pngData = makePng(600, 600, 4)
await withHook('writeFile', ({ path }) => path === pngPath + '.tmp' ? makeErr('ENOSPC') : null, async() => {
  await checkThrowsCode('写入失败抛 disk_full', () => coverFile.applyCoverImage(audioPath, pngData), 'disk_full')
})
check('写入失败时当前 JPEG 仍可用', await fsShim.readFile(jpgPath, 'base64'), secondJpeg.toString('base64'))
check('写入失败后无临时文件', await fsShim.existsFile(pngPath + '.tmp'), false)

check('切换到 PNG', await coverFile.applyCoverImage(audioPath, pngData), { imagePath: pngPath, format: 'png' })
check('旧 JPEG 已删除', await fsShim.existsFile(jpgPath), false)
check('PNG 文件为当前封面', (await coverFile.getCoverState(audioPath)).imagePath, pngPath)
check('切换格式不创建备份', await fsShim.existsFile(jpgBackupPath) || await fsShim.existsFile(pngBackupPath), false)

await fsShim.writeFile(jpgPath, secondJpeg.toString('base64'), 'base64')
await fsShim.writeFile(jpgBackupPath, 'legacy-backup')
check('删除同名封面', await coverFile.deleteCover(audioPath), true)
check('JPEG 和 PNG 均已删除', await Promise.all([fsShim.existsFile(jpgPath), fsShim.existsFile(pngPath)]), [false, false])
check('旧备份不会被读取', await coverFile.getCoverState(audioPath), { imageExists: false })
check('重复删除无效果', await coverFile.deleteCover(audioPath), false)
check('删除后可重新匹配', await coverFile.applyCoverImage(audioPath, firstJpeg), { imagePath: jpgPath, format: 'jpg' })
await withHook('unlink', ({ path }) => path === jpgPath ? makeErr('EPERM') : null, async() => {
  await checkThrowsCode('删除权限不足时报告错误', () => coverFile.deleteCover(audioPath), 'no_permission')
})
check('删除失败后文件仍存在', await fsShim.existsFile(jpgPath), true)
fs.mkdirSync(realOf(pngPath))
fs.writeFileSync(path.join(realOf(pngPath), 'keep.txt'), 'keep')
check('删除封面时跳过同名目录', await coverFile.deleteCover(audioPath), true)
check('同名目录内容仍在', fs.readFileSync(path.join(realOf(pngPath), 'keep.txt'), 'utf8'), 'keep')

console.log('\n== 同名歌词覆盖和删除 ==')
const lrcPath = lrcFile.getLrcFilePath(audioPath)
const upperLrcPath = lrcPath.slice(0, -4) + '.LRC'
const lrcBackupPath = lrcPath + '.bak'
check('首次写入返回同名 LRC 路径', await lrcFile.writeLrcFile(audioPath, 'first lyric'), { lrcPath })
await checkThrowsCode('批量模式保留已有歌词', () => lrcFile.writeLrcFile(audioPath, 'batch lyric', true), 'already_exists')
await lrcFile.writeLrcFile(audioPath, 'matched lyric')
check('直接覆盖旧歌词', await fsShim.readFile(lrcPath, 'utf8'), 'matched lyric\n')
check('覆盖不产生备份', await fsShim.existsFile(lrcBackupPath), false)
await fsShim.unlink(lrcPath)
await fsShim.writeFile(upperLrcPath, 'uppercase lyric')
await fsShim.writeFile(lrcBackupPath, 'legacy-backup')
check('能识别大写 LRC', (await lrcFile.getLrcState(audioPath)).lrcExists, true)
check('删除同名歌词', await lrcFile.deleteLrcFile(audioPath), true)
check('LRC 已被删除', await fsShim.existsFile(upperLrcPath), false)
check('旧备份不会被读取', await lrcFile.getLrcState(audioPath), { lrcExists: false })
check('重复删除无效果', await lrcFile.deleteLrcFile(audioPath), false)
check('删除后可重新匹配', await lrcFile.writeLrcFile(audioPath, 'rematched lyric'), { lrcPath })

const invalidDir = '/work/invalid'
resetDir(invalidDir)
const invalidAudio = `${invalidDir}/Song.mp3`
await fsShim.writeFile(invalidAudio, 'audio-invalid')
await checkThrowsCode('不存在的音频路径拒绝写入', () => coverFile.applyCoverImage(`${invalidDir}/missing.mp3`, makeJpeg(500, 500, 13)), 'invalid_file')
await checkThrowsCode('不存在的音频路径拒绝删除', () => coverFile.deleteCover(`${invalidDir}/missing.mp3`), 'invalid_file')
await checkThrowsCode('像素过小图片拒绝写入（image_invalid）', () => coverFile.applyCoverImage(invalidAudio, makeJpeg(100, 100)), 'image_invalid')
await checkThrowsCode('超 8MB 图片拒绝写入（image_too_large）', () => coverFile.applyCoverImage(invalidAudio, tooLargeData), 'image_too_large')
await checkThrowsCode('webp 图片拒绝写入（image_invalid）', () => coverFile.applyCoverImage(invalidAudio, Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 ', 'binary')), 'image_invalid')
check('非法输入后不产生图片', await fsShim.existsFile(`${invalidDir}/Song.jpg`), false)
check('非法输入后无 tmp', fs.readdirSync(realOf(invalidDir)).filter(name => name.endsWith('.tmp')), [])

console.log('\n== A4 coverFile：读取优先 jpg + 音频不变 + 全局无残留 ==')
const priorityDir = '/work/priority'
resetDir(priorityDir)
const priorityAudio = `${priorityDir}/Song.flac`
await fsShim.writeFile(priorityAudio, 'audio-priority')
const priorityPng = `${priorityDir}/Song.png`
const priorityJpg = `${priorityDir}/Song.jpg`
await fsShim.writeFile(priorityPng, 'png-image')
check('只有 png 时返回 png', (await coverFile.getCoverImagePathIfExists(priorityAudio))?.path, priorityPng)
await fsShim.writeFile(priorityJpg, 'jpg-image')
check('jpg/png 同时存在优先 jpg', (await coverFile.getCoverImagePathIfExists(priorityAudio))?.path, priorityJpg)

check('音频文件内容最终未变', await fsShim.readFile(audioPath, 'base64'), audioBase64Before)
check('音频文件 mtime 最终未变', (await fsShim.stat(audioPath)).lastModified, audioMtimeBefore)
check('音频未被写成/删除（仍为文件）', (await fsShim.stat(audioPath)).isFile, true)
const residue = fs.existsSync(realOf('/work'))
  ? fs.readdirSync(realOf('/work'), { recursive: true }).filter(name => String(name).endsWith('.tmp'))
  : []
check('全部场景无 tmp 残留', residue, [])

console.log(`\nresult: ${passed} passed, ${failed} failed`)
if (failed) {
  console.log(`failed cases: ${failures.join(', ')}`)
  process.exitCode = 1
}
