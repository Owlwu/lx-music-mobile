// 在线歌词匹配的文本归一化（纯函数，无平台依赖）

const fullWidthRxp = /[\uFF01-\uFF5E]/g
const fullWidthSpaceRxp = /\u3000/g
// 常见中英文标点、符号与空白；比较时统一去掉
const ignorableRxp = /[\s!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~。、，．：；？！“”‘’（）【】「」『』《》〈〉・·～~]/g

/**
 * 全角字符转半角
 */
export const toHalfWidth = (str: string): string => {
  if (!str) return ''
  return str
    .replace(fullWidthRxp, char => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .replace(fullWidthSpaceRxp, ' ')
}

/**
 * 合并连续空白并去掉首尾空白
 */
export const collapseWhitespace = (str: string): string => str.replace(/\s+/g, ' ').trim()

/**
 * 用于匹配比较的归一化：
 * 全角转半角、小写、去空白/标点、括号统一
 */
export const normalizeText = (str?: string | null): string => {
  if (!str) return ''
  return toHalfWidth(str)
    .toLowerCase()
    .replace(ignorableRxp, '')
}

/**
 * bigram Dice 相似度（0..1）
 */
export const bigramDice = (a: string, b: string): number => {
  if (!a || !b) return 0
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0

  const aBigrams = new Map<string, number>()
  for (let i = 0; i < a.length - 1; i++) {
    const gram = a.substring(i, i + 2)
    aBigrams.set(gram, (aBigrams.get(gram) ?? 0) + 1)
  }

  let overlap = 0
  for (let i = 0; i < b.length - 1; i++) {
    const gram = b.substring(i, i + 2)
    const count = aBigrams.get(gram)
    if (count == null || count <= 0) continue
    aBigrams.set(gram, count - 1)
    overlap++
  }

  return (2 * overlap) / (a.length - 1 + b.length - 1)
}
