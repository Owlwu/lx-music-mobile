/**
 * 本地歌曲同名附属文件（封面/歌词）路径测试
 *
 * 运行：node tests/music-sidecar.test.mjs
 * 纯函数验证：路径集合、音频不被加入、URI/相对路径返回空、去重。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

let failed = 0
let passed = 0
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}\n       actual   = ${a}\n       expected = ${b}`)
  }
}

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url))
const moduleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-music-sidecar-'))
const relPath = 'utils/musicSidecar.ts'
fs.writeFileSync(
  path.join(moduleDir, 'musicSidecar.ts'),
  fs.readFileSync(path.join(sourceRoot, relPath), 'utf8'),
  'utf8',
)
const { getLocalMusicSidecarPaths } = await import(pathToFileURL(path.join(moduleDir, 'musicSidecar.ts')).href)

console.log('\n== 路径生成 ==')
const audio = '/storage/emulated/0/Music/Petit Rabbit\'s/Daydream café.mp3'
const paths = getLocalMusicSidecarPaths(audio)
const expectedNames = [
  "Daydream café.lrc",
  "Daydream café.LRC",
  "Daydream café.lrc.bak",
  "Daydream café.LRC.bak",
  "Daydream café.lrc.tmp",
  "Daydream café.LRC.tmp",
  "Daydream café.lrc.restore.tmp",
  "Daydream café.LRC.restore.tmp",
  "Daydream café.jpg",
  "Daydream café.png",
  "Daydream café.jpg.bak",
  "Daydream café.png.bak",
  "Daydream café.jpg.tmp",
  "Daydream café.png.tmp",
  "Daydream café.jpg.rollback.tmp",
  "Daydream café.png.rollback.tmp",
  "Daydream café.jpg.bak.replaced.tmp",
  "Daydream café.png.bak.replaced.tmp",
]
check('生成歌词/封面及备份路径（18 个）', paths.length, expectedNames.length)
check('路径全部位于歌曲同目录', paths.every(p => p.startsWith('/storage/emulated/0/Music/Petit Rabbit\'s/')), true)
check('包含 .lrc 与 .lrc.bak', [paths.includes('/storage/emulated/0/Music/Petit Rabbit\'s/Daydream café.lrc'), paths.includes('/storage/emulated/0/Music/Petit Rabbit\'s/Daydream café.lrc.bak')], [true, true])
check('包含 jpg/png 与各自 .bak', [
  paths.includes('/storage/emulated/0/Music/Petit Rabbit\'s/Daydream café.jpg'),
  paths.includes('/storage/emulated/0/Music/Petit Rabbit\'s/Daydream café.png'),
  paths.includes('/storage/emulated/0/Music/Petit Rabbit\'s/Daydream café.jpg.bak'),
  paths.includes('/storage/emulated/0/Music/Petit Rabbit\'s/Daydream café.png.bak'),
], [true, true, true, true])
check('不包含音频路径', paths.includes(audio), false)
check('路径无重复', new Set(paths).size, paths.length)
check('所有路径不等于音频路径', paths.some(p => p === audio), false)

console.log('\n== 多扩展名/边界 ==')
check('flac 去扩展名正确', getLocalMusicSidecarPaths('/m/a.b.flac')[0], '/m/a.b.lrc')
check('无扩展名音频', getLocalMusicSidecarPaths('/m/noext')[0], '/m/noext.lrc')
check('文件名带点（无扩展名）', getLocalMusicSidecarPaths('/m/a.b')[0], '/m/a.lrc')
check('目录带点仍按文件名扩展名处理', getLocalMusicSidecarPaths('/m.d/song.mp3')[0], '/m.d/song.lrc')
check('URI 返回空', getLocalMusicSidecarPaths('content://media/external/audio/1.mp3'), [])
check('相对路径返回空', getLocalMusicSidecarPaths('Music/song.mp3'), [])
check('空值返回空', getLocalMusicSidecarPaths(''), [])
check('Windows 反斜杠路径返回空（Android 仅支持 / 绝对路径）', getLocalMusicSidecarPaths('E:\\Music\\song.mp3'), [])

console.log('\n== deleteLocalMusicFiles 接线 ==')
const fsStub = `
export const unlink = async (p) => {
  globalThis.__deletedPaths.push(p)
  if (globalThis.__failAudio && p === '/m/song.mp3') throw new Error('audio failed')
  if (globalThis.__failSidecar && p !== '/m/song.mp3') throw new Error('sidecar failed')
  return true
}
export const existsFile = async () => true
`
const pathStub = `
export const checkWritableLocalPath = () => 'ok'
`
fs.writeFileSync(path.join(moduleDir, 'fs.stub.ts'), fsStub, 'utf8')
fs.writeFileSync(path.join(moduleDir, 'localPathCheck.stub.ts'), pathStub, 'utf8')
fs.writeFileSync(
  path.join(moduleDir, 'music.ts'),
  fs.readFileSync(path.join(sourceRoot, 'utils/music.ts'), 'utf8')
    .replace(/from '\.\/fs'/, "from './fs.stub.ts'")
    .replace(/from '\.\/localPathCheck'/, "from './localPathCheck.stub.ts'")
    .replace(/from '\.\/musicSidecar'/, "from './musicSidecar.ts'"),
  'utf8',
)
const { deleteLocalMusicFiles } = await import(pathToFileURL(path.join(moduleDir, 'music.ts')).href)

globalThis.__deletedPaths = []
globalThis.__failAudio = false
globalThis.__failSidecar = false
await deleteLocalMusicFiles({ meta: { filePath: '/m/song.mp3' } })
check('删除音频 + 18 个附属文件', globalThis.__deletedPaths.length, 19)
check('包含音频路径', globalThis.__deletedPaths.includes('/m/song.mp3'), true)
check('包含歌词/封面及备份', [
  globalThis.__deletedPaths.includes('/m/song.lrc'),
  globalThis.__deletedPaths.includes('/m/song.lrc.bak'),
  globalThis.__deletedPaths.includes('/m/song.jpg'),
  globalThis.__deletedPaths.includes('/m/song.jpg.bak'),
  globalThis.__deletedPaths.includes('/m/song.png.bak'),
], [true, true, true, true, true])

globalThis.__deletedPaths = []
globalThis.__failSidecar = true
let sidecarOk = true
try {
  await deleteLocalMusicFiles({ meta: { filePath: '/m/song.mp3' } })
} catch {
  sidecarOk = false
}
check('附属文件删除失败静默忽略', sidecarOk, true)

globalThis.__failSidecar = false
globalThis.__failAudio = true
let audioRejected = false
try {
  await deleteLocalMusicFiles({ meta: { filePath: '/m/song.mp3' } })
} catch {
  audioRejected = true
}
check('音频删除失败仍向上抛错（原行为）', audioRejected, true)

fs.rmSync(moduleDir, { recursive: true, force: true })
console.log(failed ? `\nresult: ${passed} passed, ${failed} failed` : `\nresult: ${passed} passed, 0 failed`)
process.exit(failed ? 1 : 0)
