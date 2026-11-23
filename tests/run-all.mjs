/**
 * 顺序运行 tests/ 下的全部业务脚本，任一失败则整体退出 1。
 * 每个脚本自己打印断言数，这里只汇总文件级结果。
 *
 * 用法（仓库根目录）：npm run test
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [major, minor] = process.versions.node.split('.').map(Number)
const supportsTypeStripping = (major === 22 && minor >= 18) || (major === 23 && minor >= 6) || major >= 24
if (!supportsTypeStripping) {
  console.error(`业务测试需要 Node >= 22.18（或 >= 23.6）：依赖 Node 内置的 TypeScript 类型擦除，当前 ${process.version}。`)
  process.exit(1)
}

const dir = dirname(fileURLToPath(import.meta.url))
const files = readdirSync(dir).filter(name => name.endsWith('.test.mjs')).sort()
let failed = 0

for (const name of files) {
  console.log(`\n### ${name}`)
  const result = spawnSync(process.execPath, [join(dir, name)], { stdio: 'inherit' })
  if (result.status !== 0) {
    failed++
    console.error(`### ${name} 失败（exit ${result.status ?? result.signal}）`)
  }
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${files.length - failed}/${files.length} 个测试文件通过`)
process.exit(failed ? 1 : 0)
