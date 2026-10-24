import { appendFile, existsFile, readFile, stat, temporaryDirectoryPath, unlink, writeFile } from '@/utils/fs'

/**
 * 本地歌曲导入日志
 *
 * 为什么单独一份文件：设置页的「查看日志」原本读的是历史遗留的 `error.log`，
 * 而那个通道被所有模块共用（同步、存储、全局异常、元数据编辑……），于是用户想看
 * 「刚才导入这批歌为什么失败」时，看到的是满屏的其它错误，真正的失败原因被埋掉了。
 * 现在导入相关的记录只写这里、也只在这里展示，两者彻底分开：
 *
 * - 本文件：导入本地歌曲的失败情况（哪个目录、哪个文件、为什么没读出来）
 * - `runtime.log`：程序运行日志（「分享日志」导出，用于排查 bug）
 *
 * 与 runtimeLog 一致的取舍：
 * 1. 任何失败都静默降级，日志自身绝不能反过来把导入流程搞崩；
 * 2. 文件有上限（超出后只保留尾部），不会因为反复导入而无限增长；
 * 3. 写入串行排队，避免多条 append 并发把行写乱。
 */

/** 单个文件上限（字节）：导入失败记录体积很小，256KB 足够覆盖很久的历史 */
const maxFileSize = 256 * 1024

/**
 * 超限后保留的字符数。
 *
 * 用字符数而非字节数：本文件以中文为主（UTF-8 下 1 字符最多 3 字节），
 * 取 maxFileSize / 3 可保证保留内容的字节数一定不会超过上限。
 */
const maxKeepChars = Math.floor(maxFileSize / 3)

let cachedPath: string | null = null

/**
 * 日志文件路径（惰性解析）。平台目录在极早期可能尚未就绪，
 * 拼接会得到 `undefined/import.log` 这种坏路径，因此任何异常都降级为空串，
 * 调用方见到空串即跳过所有文件操作。
 */
const getPath = (): string => {
  if (cachedPath == null) {
    try {
      const dir = temporaryDirectoryPath
      cachedPath = typeof dir == 'string' && dir ? `${dir}/import.log` : ''
    } catch (err) {
      cachedPath = ''
    }
  }
  return cachedPath
}

/** 导入日志文件路径（不可用时返回空串） */
export const importLogPath = (): string => getPath()

const pad = (num: number, len = 2) => num.toString().padStart(len, '0')

const formatTime = (time: number) => {
  const date = new Date(time)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

const stringifyValue = (value: any): string => {
  if (typeof value == 'string') return value
  if (value instanceof Error) return value.stack ?? value.message
  if (value === undefined) return 'undefined'
  try {
    return JSON.stringify(value)
  } catch (err) {
    try {
      return String(value)
    } catch (err2) {
      return '[unserializable]'
    }
  }
}

const formatFields = (fields?: Record<string, any>): string => {
  if (fields == null) return ''
  const parts: string[] = []
  for (const key of Object.keys(fields)) {
    const value = fields[key]
    if (value === undefined) continue
    parts.push(`${key}=${stringifyValue(value)}`)
  }
  return parts.length ? ` ${parts.join(' ')}` : ''
}

/** 写入串行队列：保证多行日志的先后顺序与磁盘内容一致 */
let queue: Promise<void> = Promise.resolve()

const ensureFileReady = async(path: string): Promise<boolean> => {
  try {
    if (await existsFile(path)) return true
    await writeFile(path, '')
    return true
  } catch (err) {
    return false
  }
}

/** 按字符数保留尾部，并丢掉被截断的半行 */
const trimToTail = (text: string, maxChars: number) => {
  if (text.length <= maxChars) return text
  const tail = text.slice(text.length - maxChars)
  const index = tail.indexOf('\n')
  return index === -1 ? tail : tail.slice(index + 1)
}

/** 超出上限时只保留尾部，保证文件不会无限增长 */
const trimFileIfNeeded = async(path: string) => {
  try {
    const info = await stat(path)
    if ((info.size ?? 0) <= maxFileSize) return
    const text = await readFile(path).catch(() => '')
    await writeFile(path, trimToTail(text, maxKeepChars))
  } catch (err) {}
}

const write = (level: 'INFO' | 'WARN', message: string, fields?: Record<string, any>) => {
  const path = getPath()
  if (!path) return
  const line = `${formatTime(Date.now())} ${level} ${message}${formatFields(fields)}`
  queue = queue.then(async() => {
    if (!await ensureFileReady(path)) return
    await trimFileIfNeeded(path)
    await appendFile(path, line + '\n')
  }).catch((err) => {
    // 日志自身失败绝不影响导入流程，只打一条控制台便于开发时发现
    try {
      console.log('[importLog] write failed', err)
    } catch (err2) {}
  })
}

export const importLog = {
  /** 正常流程记录（导入开始/结束、扫描到的文件数等） */
  info(message: string, fields?: Record<string, any>) {
    write('INFO', message, fields)
  },
  /** 导入失败记录（目录读不出、歌曲信息解析失败等） */
  warn(message: string, fields?: Record<string, any>) {
    write('WARN', message, fields)
  },
}

/** 等待排队中的写入全部落盘（读取前调用，保证能看到刚刚产生的记录） */
const flushQueue = async() => {
  await queue.catch(() => {})
}

/** 读取导入日志全文；文件不存在或不可用时返回空串 */
export const readImportLog = async(): Promise<string> => {
  const path = getPath()
  if (!path) return ''
  await flushQueue()
  try {
    if (!await existsFile(path)) return ''
    return await readFile(path).catch(() => '')
  } catch (err) {
    return ''
  }
}

/** 清空导入日志（删除文件后重建为空文件，避免覆盖原有文件权限） */
export const clearImportLogFile = async(): Promise<void> => {
  const path = getPath()
  await flushQueue()
  if (!path) return
  try {
    await unlink(path)
  } catch (err) {}
  try {
    await writeFile(path, '')
  } catch (err) {}
}
