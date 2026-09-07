/**
 * hanzi-writer-data 的笔画是 SVG path，只用到 M / L / Q / C / Z 且全为绝对坐标。
 * 坐标系是 1024 见方、y 轴向上，字身盒子从 (0, -124) 到 (1024, 900)。
 * 这里把它仿射变换到「毫米、y 轴向下、原点在页面左上角」的统一空间。
 */

/** 仿射矩阵 [a b c d e f]：x' = a·x + c·y + e，y' = b·x + d·y + f */
export type Matrix = readonly [number, number, number, number, number, number]

export const GLYPH_BOX = 1024
/** 字身盒子顶边在原始数据里的 y 值 */
export const GLYPH_TOP = 900

const SEGMENT = /([MLQCZ])([^MLQCZ]*)/g
const NUMBER = /-?\d*\.?\d+/g

const fmt = (v: number) => {
  const r = Math.round(v * 100) / 100
  return Object.is(r, -0) ? '0' : String(r)
}

export function transformPath(d: string, m: Matrix): string {
  const [a, b, c, dy, e, f] = m
  const out: string[] = []
  for (const seg of d.matchAll(SEGMENT)) {
    const cmd = seg[1]
    if (cmd === 'Z') {
      out.push('Z')
      continue
    }
    const nums = seg[2].match(NUMBER)
    if (!nums) continue
    const parts = [cmd]
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const x = Number(nums[i])
      const y = Number(nums[i + 1])
      parts.push(fmt(a * x + c * y + e), fmt(b * x + dy * y + f))
    }
    out.push(parts.join(' '))
  }
  return out.join(' ')
}

/**
 * 把字身盒子居中放进一个格子。
 * ratio 是字占格子的比例 —— 贴边写起来会挤，留白才像字帖。
 */
export function glyphMatrix(cellX: number, cellY: number, size: number, ratio: number): Matrix {
  const glyph = size * ratio
  const k = glyph / GLYPH_BOX
  const pad = (size - glyph) / 2
  return [k, 0, 0, -k, cellX + pad, cellY + pad + GLYPH_TOP * k]
}
