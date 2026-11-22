/**
 * 移动端 Phase 6：音乐文件同步 · 歌词/封面伴生文件（Sidecar v2）
 *
 * 运行：node tests/music-file-sync.test.mjs
 *
 * `diff.ts` 与桌面端逐字节镜像（桌面 `tests/music-file-fs.test.ts` 有字节一致断言），
 * 本测试直接 import 真实源码，覆盖：
 * - 封面索引：`.jpg/.png` 小写、jpg 优先、png 回退、`.JPG` 不参与、孤立刻面忽略；
 * - `FileIndex.coverSupport`：buildIndex 不伪造、localFs.scanIndex 标记 true；
 * - 只改 `.lrc` / 只改 `.jpg` 不产生 PlanItem；
 * - PlanItem 的 upload/download/local/remote sidecars 规则（target 已有 → 不传、不覆盖）；
 * - 旧对端（无 coverSupport）→ 不传/不删封面，歌词照常；
 * - 删除动作携带该侧实际存在的歌词/封面；
 * - TransferAction 用 `sidecars` 取代 `hasLyric`，`getActionTargets` 含伴生路径；
 * - 图片路径通过 `assertSafeRelPath` 可用于通用删除（static 校验 localFs 无扩展名白名单）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  buildActions,
  buildIndex,
  buildPlan,
  getActionTargets,
  getCoverFileName,
  getCoverFormat,
  getCoverRelPath,
  getLyricRelPath,
  isCoverFileName,
  isSafeRelPath,
  planSelectionKey,
} from '../src/plugins/sync/client/modules/musicFile/diff.ts'

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

const entry = (filePath, size, mtime = 1000, sig) => ({
  path: filePath,
  size,
  mtime,
  ...(sig ? { sig } : {}),
})

/** 一首歌 + 可选歌词/jpg/png 的扫描条目 */
const audioEntry = (filePath, size, options = {}) => {
  const list = [entry(filePath, size, 1000, options.sig)]
  if (options.lyric) list.push(entry(getLyricRelPath(filePath), options.lyric.size, options.lyric.mtime ?? 2000))
  if (options.jpg) list.push(entry(getCoverRelPath(filePath, 'jpg'), options.jpg.size, options.jpg.mtime ?? 3000))
  if (options.png) list.push(entry(getCoverRelPath(filePath, 'png'), options.png.size, options.png.mtime ?? 4000))
  return list
}

const build = (...lists) => buildIndex(lists.flat())

const selected = (plan, groups) => {
  const map = {}
  for (const group of Object.keys(plan)) {
    for (const item of plan[group]) map[planSelectionKey(group, item.path)] = false
  }
  for (const [group, relPath] of groups) map[planSelectionKey(group, relPath)] = true
  return map
}

const groupPaths = (plan, group) => plan[group].map(item => item.path)

const planItem = (plan, group, relPath) => plan[group].find(item => item.path === relPath)

console.log('\n== A1 封面路径/扩展名规则 ==')
check('getCoverRelPath flac -> jpg', getCoverRelPath('a/b/c.flac', 'jpg'), 'a/b/c.jpg')
check('getCoverRelPath flac -> png', getCoverRelPath('a/b/c.flac', 'png'), 'a/b/c.png')
check('getCoverRelPath 无扩展名', getCoverRelPath('a/b/c', 'jpg'), 'a/b/c.jpg')
check('getCoverFileName', getCoverFileName('c.flac', 'png'), 'c.png')
check('isCoverFileName jpg', isCoverFileName('a.jpg'), true)
check('isCoverFileName png', isCoverFileName('a.png'), true)
check('isCoverFileName .JPG 不参与', isCoverFileName('a.JPG'), false)
check('isCoverFileName .PNG 不参与', isCoverFileName('a.PNG'), false)
check('isCoverFileName jpeg 不参与', isCoverFileName('a.jpeg'), false)
check('isCoverFileName webp 不参与', isCoverFileName('a.webp'), false)
check('getCoverFormat 大写返回 null', getCoverFormat('a.JPG'), null)
check('歌词路径规则不变', getLyricRelPath('a/b/c.flac'), 'a/b/c.lrc')

console.log('\n== A2 buildIndex：封面挂载 / jpg 优先 / 大小写 / 孤立文件 ==')
const basic = build(
  audioEntry('a/song.flac', 100, { lyric: { size: 10 }, jpg: { size: 20, mtime: 3333 } }),
  audioEntry('a/no-sidecar.mp3', 50),
  [{ path: 'notaudio.txt', size: 1, mtime: 0 }],
  [{ path: 'a/orphan.jpg', size: 9, mtime: 0 }],
)
check('索引只保留音频', basic.files.map(file => file.path), ['a/no-sidecar.mp3', 'a/song.flac'])
const basicSong = basic.files.find(file => file.path === 'a/song.flac')
check('歌词挂载', basicSong.lyric, { size: 10, mtime: 2000 })
check('封面挂载（jpg）', basicSong.cover, { format: 'jpg', size: 20, mtime: 3333 })
check('无伴生文件为 null', basic.files.find(file => file.path === 'a/no-sidecar.mp3').cover, null)
check('孤立封面不产生音频条目', basic.files.some(file => file.path === 'a/orphan.jpg'), false)
check('buildIndex 不伪造 coverSupport', basic.coverSupport, undefined)

const both = build(
  audioEntry('b/song.mp3', 100, { png: { size: 30 }, jpg: { size: 40 } }),
)
check('jpg/png 同时存在取 jpg', both.files[0].cover, { format: 'jpg', size: 40, mtime: 3000 })

// 目录枚举顺序反着来也必须 jpg 优先
const bothReversed = build(
  audioEntry('b/song.mp3', 100, { png: { size: 30 } }),
  [entry(getCoverRelPath('b/song.mp3', 'jpg'), 40, 3000)],
)
check('枚举顺序不影响 jpg 优先', bothReversed.files[0].cover.format, 'jpg')

const pngOnly = build(audioEntry('c/song.flac', 100, { png: { size: 30 } }))
check('只有 png 时回退 png', pngOnly.files[0].cover, { format: 'png', size: 30, mtime: 4000 })

const upper = build(
  audioEntry('d/song.flac', 100),
  [entry('d/song.JPG', 40, 3000)],
)
check('.JPG 不参与封面索引', upper.files[0].cover, null)

const otherStem = build(
  audioEntry('e/song.flac', 100),
  audioEntry('e/other.flac', 100, { jpg: { size: 20 } }),
)
check('封面只挂同 stem 音频', otherStem.files.find(file => file.path === 'e/song.flac').cover, null)

console.log('\n== A3 localFs 接线：scanEntries 收封面、scanIndex 标 coverSupport ==')
const localFsSource = fs.readFileSync(path.join(sourceRoot, 'plugins/sync/client/modules/musicFile/localFs.ts'), 'utf8')
check('scanEntries 引入 isCoverFileName', localFsSource.includes('isCoverFileName'), true)
check('scanEntries 把封面纳入过滤', /!isAudio\s*&&\s*!isLyricFileName\(name\)\s*&&\s*!isCoverFileName\(name\)/.test(localFsSource), true)
check('scanIndex 返回 coverSupport:true', /return \{ \.\.\.index, coverSupport: true \}/.test(localFsSource), true)
check('删除注释说明封面走通用 deleteFileWithLyric(coverPath,false)', /withLyric=false/.test(localFsSource) && /通用删除/.test(localFsSource), true)
check('图片相对路径通过安全校验（可被通用删除）', isSafeRelPath(getCoverRelPath('a/song.flac', 'jpg')), true)
check('封面路径不会被误判为不安全（png）', isSafeRelPath('a/song.png'), true)

console.log('\n== B1 只改伴生文件不产生 PlanItem ==')
const sidecarOnlyLocal = build(
  audioEntry('a.flac', 100, { lyric: { size: 11 }, jpg: { size: 21 } }),
  audioEntry('b.flac', 200, { lyric: { size: 12 } }),
  audioEntry('c.flac', 300),
)
const sidecarOnlyRemote = build(
  audioEntry('a.flac', 100, { lyric: { size: 99 }, png: { size: 88 } }),
  audioEntry('b.flac', 200),
  audioEntry('c.flac', 300, { jpg: { size: 77 } }),
)
const sidecarOnlyPlan = buildPlan(sidecarOnlyLocal, sidecarOnlyRemote, [])
check('仅伴生差异 -> 全部组为空', Object.fromEntries(Object.keys(sidecarOnlyPlan).map(group => [group, sidecarOnlyPlan[group].length])), {
  remoteAdded: 0,
  localAdded: 0,
  remoteDeleted: 0,
  localDeleted: 0,
  conflict: 0,
})
check('仅新增本地封面不产生 localAdded', groupPaths(sidecarOnlyPlan, 'localAdded'), [])

console.log('\n== B2 sidecar 规则：缺什么补什么、target 已有不覆盖 ==')
const local = build(
  audioEntry('local-added.flac', 100, { lyric: { size: 10 }, jpg: { size: 20 } }),
  audioEntry('conflict.flac', 300, { lyric: { size: 30 }, jpg: { size: 40 } }),
  audioEntry('remote-del.flac', 400, { lyric: { size: 41 }, jpg: { size: 42 } }),
  audioEntry('done.flac', 500, { lyric: { size: 50 }, jpg: { size: 51 } }),
)
const remote = build(
  audioEntry('remote-added.flac', 200, { lyric: { size: 21 }, png: { size: 22 } }),
  audioEntry('conflict.flac', 301, { lyric: { size: 31 }, png: { size: 41 } }),
  audioEntry('local-del.flac', 600, { lyric: { size: 61 }, png: { size: 62 } }),
  audioEntry('done.flac', 500, { lyric: { size: 52 } }),
)
remote.coverSupport = true
const plan = buildPlan(local, remote, ['remote-del.flac', 'local-del.flac'])

check('分组：localAdded', groupPaths(plan, 'localAdded'), ['local-added.flac'])
check('分组：remoteAdded', groupPaths(plan, 'remoteAdded'), ['remote-added.flac'])
check('分组：conflict', groupPaths(plan, 'conflict'), ['conflict.flac'])
check('分组：remoteDeleted', groupPaths(plan, 'remoteDeleted'), ['remote-del.flac'])
check('分组：localDeleted', groupPaths(plan, 'localDeleted'), ['local-del.flac'])
check('两端一致的歌曲不出现在清单', groupPaths(plan, 'conflict').includes('done.flac'), false)

const added = planItem(plan, 'localAdded', 'local-added.flac')
check('localAdded uploadSidecars（歌词+jpg）', added.uploadSidecars, [
  { path: 'local-added.lrc', size: 10, kind: 'lyric' },
  { path: 'local-added.jpg', size: 20, kind: 'cover' },
])
check('localAdded cover 存在标记', [added.localHasCover, added.remoteHasCover], [true, false])

const remoteAdded = planItem(plan, 'remoteAdded', 'remote-added.flac')
check('remoteAdded downloadSidecars（歌词+png）', remoteAdded.downloadSidecars, [
  { path: 'remote-added.lrc', size: 21, kind: 'lyric' },
  { path: 'remote-added.png', size: 22, kind: 'cover' },
])

const conflict = planItem(plan, 'conflict', 'conflict.flac')
check('conflict 两端都有歌词/封面 -> 不传 sidecar', [conflict.uploadSidecars, conflict.downloadSidecars], [[], []])
check('conflict 封面存在标记', [conflict.localHasCover, conflict.remoteHasCover], [true, true])
check('conflict 本地删除列表是该侧实际文件（jpg）', conflict.localSidecars, [
  { path: 'conflict.lrc', size: 30, kind: 'lyric' },
  { path: 'conflict.jpg', size: 40, kind: 'cover' },
])
check('conflict 对端删除列表用对端格式（png）', conflict.remoteSidecars, [
  { path: 'conflict.lrc', size: 31, kind: 'lyric' },
  { path: 'conflict.png', size: 41, kind: 'cover' },
])

const remoteDeleted = planItem(plan, 'remoteDeleted', 'remote-del.flac')
check('remoteDeleted localSidecars 含歌词+封面', remoteDeleted.localSidecars, [
  { path: 'remote-del.lrc', size: 41, kind: 'lyric' },
  { path: 'remote-del.jpg', size: 42, kind: 'cover' },
])
const localDeleted = planItem(plan, 'localDeleted', 'local-del.flac')
check('localDeleted remoteSidecars 含歌词+封面', localDeleted.remoteSidecars, [
  { path: 'local-del.lrc', size: 61, kind: 'lyric' },
  { path: 'local-del.png', size: 62, kind: 'cover' },
])

console.log('\n== B3 旧对端（无 coverSupport）：不传/不删封面，歌词照常 ==')
const oldPeerLocal = build(audioEntry('old.flac', 100, { lyric: { size: 10 }, jpg: { size: 20 } }))
const oldPeerRemote = build(audioEntry('old.flac', 101))
check('旧对端覆盖标记缺失', oldPeerRemote.coverSupport, undefined)
const oldPeerPlan = buildPlan(oldPeerLocal, oldPeerRemote, [])
const oldPeerConflict = oldPeerPlan.conflict[0]
check('旧对端：只传歌词、不传封面', oldPeerConflict.uploadSidecars, [
  { path: 'old.lrc', size: 10, kind: 'lyric' },
])
check('旧对端：不删对端封面', oldPeerConflict.remoteSidecars, [])

const oldRemoteCover = build(audioEntry('cover-old.flac', 501, { png: { size: 50 } }))
const oldLocalNoCover = build(audioEntry('cover-old.flac', 500))
const oldCoverPlan = buildPlan(oldLocalNoCover, oldRemoteCover, [])
check('旧对端已有封面也不下载', oldCoverPlan.conflict[0].downloadSidecars, [])
check('旧对端封面仍标记为存在（但不处理）', oldCoverPlan.conflict[0].remoteHasCover, true)

const oldDeletedRemote = build(audioEntry('gone.flac', 700, { lyric: { size: 70 }, jpg: { size: 71 } }))
const oldDeletedLocal = build()
const oldDeletedPlan = buildPlan(oldDeletedLocal, oldDeletedRemote, ['gone.flac'])
check('旧对端：删除歌曲只删歌词', oldDeletedPlan.localDeleted[0].remoteSidecars, [
  { path: 'gone.lrc', size: 70, kind: 'lyric' },
])

console.log('\n== C1 buildActions / getActionTargets ==')
const allSelected = selected(plan, [
  ['localAdded', 'local-added.flac'],
  ['remoteAdded', 'remote-added.flac'],
  ['remoteDeleted', 'remote-del.flac'],
  ['localDeleted', 'local-del.flac'],
  ['conflict', 'conflict.flac'],
])
const actions = buildActions(plan, allSelected, {})
const actionOf = filePath => actions.find(action => action.path === filePath)
check('upload 动作携带 uploadSidecars', actionOf('local-added.flac'), {
  kind: 'upload',
  path: 'local-added.flac',
  size: 100,
  sidecars: [
    { path: 'local-added.lrc', size: 10, kind: 'lyric' },
    { path: 'local-added.jpg', size: 20, kind: 'cover' },
  ],
})
check('download 动作携带 downloadSidecars', actionOf('remote-added.flac').sidecars, [
  { path: 'remote-added.lrc', size: 21, kind: 'lyric' },
  { path: 'remote-added.png', size: 22, kind: 'cover' },
])
check('delete_local 动作携带 localSidecars', actionOf('remote-del.flac').sidecars, [
  { path: 'remote-del.lrc', size: 41, kind: 'lyric' },
  { path: 'remote-del.jpg', size: 42, kind: 'cover' },
])
check('delete_remote 动作携带 remoteSidecars', actionOf('local-del.flac').sidecars, [
  { path: 'local-del.lrc', size: 61, kind: 'lyric' },
  { path: 'local-del.png', size: 62, kind: 'cover' },
])
check('动作不再使用 hasLyric 字段', actions.every(action => !('hasLyric' in action)), true)
check('动作数量', actions.length, 5)
check('getActionTargets 含音频与伴生文件', getActionTargets(actionOf('local-added.flac')), [
  'local-added.flac',
  'local-added.lrc',
  'local-added.jpg',
])
check('删除动作 targets 也含伴生文件', getActionTargets(actionOf('local-del.flac')), [
  'local-del.flac',
  'local-del.lrc',
  'local-del.png',
])

const pushSelection = selected(plan, [['conflict', 'conflict.flac']])
const pushConflict = buildActions(plan, pushSelection, {
  [planSelectionKey('conflict', 'conflict.flac')]: 'push',
})
check('conflict 改为 push 时带 uploadSidecars', pushConflict[0], {
  kind: 'upload',
  path: 'conflict.flac',
  size: 300,
  sidecars: [],
})
const pullConflict = buildActions(plan, pushSelection, {})
check('conflict 默认 pull 时带 downloadSidecars', pullConflict[0], {
  kind: 'download',
  path: 'conflict.flac',
  size: 301,
  sidecars: [],
})
check('未勾选不产生动作', buildActions(plan, {}, {}).length, 0)

console.log('\n== C2 新增歌曲且有歌词/封面时方向正确（契约 §8.2） ==')
const emptyRemote = build()
emptyRemote.coverSupport = true
const uploadOnly = buildPlan(
  build(audioEntry('dir/new.flac', 123, { lyric: { size: 12 }, jpg: { size: 13 } })),
  emptyRemote,
  [],
)
check('本地新增默认 push', uploadOnly.localAdded[0].defaultDirection, 'push')
check('本地新增 uploadSidecars 顺序：歌词在前、封面在后', uploadOnly.localAdded[0].uploadSidecars.map(item => item.kind), ['lyric', 'cover'])
const uploadOldPeer = buildPlan(
  build(audioEntry('dir/new.flac', 123, { lyric: { size: 12 }, jpg: { size: 13 } })),
  build(),
  [],
)
check('旧对端本地新增：只传歌词', uploadOldPeer.localAdded[0].uploadSidecars.map(item => item.kind), ['lyric'])
const downloadPlanFresh = buildPlan(
  build(),
  (() => {
    const index = build(audioEntry('dir/incoming.flac', 456, { lyric: { size: 22 }, png: { size: 23 } }))
    index.coverSupport = true
    return index
  })(),
  [],
)
check('远端新增默认 pull', downloadPlanFresh.remoteAdded[0].defaultDirection, 'pull')
check('远端新增 downloadSidecars 顺序：歌词在前、封面在后', downloadPlanFresh.remoteAdded[0].downloadSidecars.map(item => item.kind), ['lyric', 'cover'])

console.log('\n== D1 localFs 真实 scanIndex（RN 层用内存目录替身） ==')
const moduleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-mobile-sync-sidecar-'))
const copyWithRules = (relPath, destName, rules = []) => {
  let code = fs.readFileSync(path.join(sourceRoot, relPath), 'utf8')
  for (const [rxp, replacement] of rules) code = code.replace(rxp, replacement)
  fs.writeFileSync(path.join(moduleDir, destName), code, 'utf8')
}

copyWithRules('plugins/sync/client/modules/musicFile/diff.ts', 'diff.ts')
copyWithRules('plugins/sync/client/modules/musicFile/localFs.ts', 'localFs.ts', [
  [/from '\.\/diff'/g, "from './diff.ts'"],
  [/@\/utils\/fs/g, './fs.ts'],
  [/@\/store\/setting\/state/g, './setting.ts'],
  [/from '\.\/logger'/g, "from './logger.ts'"],
])

fs.writeFileSync(path.join(moduleDir, 'setting.ts'), `
const settingState = { setting: { 'sync.musicFile.root': '/root' } }
export default settingState
`, 'utf8')

fs.writeFileSync(path.join(moduleDir, 'logger.ts'), `
const noop = () => {}
const log = { info: noop, warn: noop, err: noop }
export default log
`, 'utf8')

fs.writeFileSync(path.join(moduleDir, 'fs.ts'), `
export const temporaryDirectoryPath = '/cache'
export const existsFile = async () => false
export const stat = async () => ({ size: 0 })
export const mkdir = async () => {}
export const unlink = async () => {}
export const writeFile = async () => {}
export const appendFile = async () => {}
export const copyFile = async () => {}
export const readFileSlice = async () => 'QUJD'
export const readDir = async (dirPath) => {
  const list = globalThis.__fakeDirs[dirPath]
  if (!list) throw new Error('ENOENT: ' + dirPath)
  return list
}
`, 'utf8')

const fileNode = (dirPath, name, size, lastModified = 1000) => ({
  name,
  path: dirPath + '/' + name,
  isDirectory: false,
  isFile: true,
  size,
  lastModified,
})
const dirNode = (dirPath, name) => ({
  name,
  path: dirPath + '/' + name,
  isDirectory: true,
  isFile: false,
})

globalThis.__fakeDirs = {
  '/root': [
    dirNode('/root', 'Album'),
    fileNode('/root', 'root.mp3', 50),
    fileNode('/root', 'root.PNG', 41),
    fileNode('/root', 'notes.txt', 5),
  ],
  '/root/Album': [
    fileNode('/root/Album', 'song.flac', 100),
    fileNode('/root/Album', 'song.lrc', 10),
    fileNode('/root/Album', 'song.jpg', 20),
    fileNode('/root/Album', 'song.png', 25),
    fileNode('/root/Album', 'song2.flac', 101),
    fileNode('/root/Album', 'song2.JPG', 40),
    fileNode('/root/Album', 'orphan.jpg', 9),
  ],
}

const localFs = await import(pathToFileURL(path.join(moduleDir, 'localFs.ts')).href)
const scanned = await localFs.scanIndex('/root', [])
check('scanIndex 返回 coverSupport:true', scanned.coverSupport, true)
check('scanIndex 只保留音频', scanned.files.map(file => file.path), ['Album/song.flac', 'Album/song2.flac', 'root.mp3'])
check('scanIndex 收集文件夹', scanned.folders, ['Album'])
const scannedSong = scanned.files.find(file => file.path === 'Album/song.flac')
check('真实扫描：歌词挂载', scannedSong.lyric, { size: 10, mtime: 1000 })
check('真实扫描：jpg 优先于 png', scannedSong.cover, { format: 'jpg', size: 20, mtime: 1000 })
check('真实扫描：音频带内容签名', typeof scannedSong.sig === 'string' && scannedSong.sig.length === 16, true)
check('真实扫描：.JPG 不参与封面', scanned.files.find(file => file.path === 'Album/song2.flac').cover, null)
check('真实扫描：.PNG 不参与封面', scanned.files.find(file => file.path === 'root.mp3').cover, null)
check('真实扫描：孤立刻面不影响索引', scanned.files.some(file => file.path === 'Album/orphan.jpg'), false)

const nestedScan = await localFs.scanIndex('/root/Album', [])
check('子目录为根时同样带 coverSupport', nestedScan.coverSupport, true)
check('子目录为根时索引正确', nestedScan.files.map(file => file.path), ['song.flac', 'song2.flac'])

let missingRootThrows = false
try {
  await localFs.scanIndex('', [])
} catch {
  missingRootThrows = true
}
check('未设置同步根目录时抛错', missingRootThrows, true)
fs.rmSync(moduleDir, { recursive: true, force: true })

console.log(`\nresult: ${passed} passed, ${failed} failed`)
if (failed) {
  console.log(`failed cases: ${failures.join(', ')}`)
  process.exitCode = 1
}
