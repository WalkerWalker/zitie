import { glyphMatrix, transformPath } from './pathTransform.ts'
import type { CharData } from './strokeData.ts'

export const A4 = { w: 210, h: 297 } as const

export type RGB = readonly [number, number, number]

/** 绘图图元。坐标一律是毫米、y 轴向下、原点在页面左上角 —— SVG 预览和 PDF 共用。 */
export type Prim =
  | {
      kind: 'line'
      x1: number
      y1: number
      x2: number
      y2: number
      w: number
      color: RGB
      dash?: readonly [number, number]
    }
  | { kind: 'path'; d: string; fill: RGB }

export type GridType = 'tian' | 'mi' | 'square'
export type GridColor = 'gray' | 'red' | 'green'

/**
 * 界面上只暴露 cols 一个旋钮，其余都是定死的值 —— 留在配置里是为了烟测能覆盖：
 * `npm run smoke -- 大 /tmp/a.pdf '{"gridType":"mi","glyphRatio":0.85}'`
 */
export type Config = {
  /** 每行几格。格子边长跟着算（横向正好铺满页宽），界面上唯一能调的。 */
  cols: number
  marginMm: number
  /** 字占格子的比例 */
  glyphRatio: number
  gridType: GridType
  gridColor: GridColor
  /** 浅灰的深浅（0 = 黑，1 = 白）。整页只有这一个灰。 */
  traceDarkness: number
  /** 笔顺排完之后再印几个整字 */
  fullCount: number
}

export const DEFAULTS: Config = {
  cols: 5,
  marginMm: 11,
  glyphRatio: 0.72,
  gridType: 'mi',
  gridColor: 'gray',
  traceDarkness: 0.82,
  fullCount: 3,
}

/**
 * 层次必须是：黑范字 > 浅灰的字 > 格子虚线。
 * 描红调得很淡之后，虚线要跟着更淡，不然十字线比字还显眼。
 */
const GRID_COLORS: Record<GridColor, { frame: RGB; inner: RGB }> = {
  gray: { frame: [0.6, 0.64, 0.7], inner: [0.88, 0.9, 0.93] },
  red: { frame: [0.87, 0.55, 0.55], inner: [0.96, 0.86, 0.86] },
  green: { frame: [0.5, 0.72, 0.57], inner: [0.87, 0.94, 0.89] },
}

/** 纯黑打印偏重，深灰更接近铅笔范字 */
const INK: RGB = [0.1, 0.1, 0.11]

const FRAME_W = 0.35
const INNER_W = 0.2
const DASH = [1.4, 1.2] as const

const CJK = /[㐀-鿿豈-﫿]/u

/** 只留汉字，去重且保持输入顺序。 */
export function normalizeChars(input: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const ch of input) {
    if (!CJK.test(ch) || seen.has(ch)) continue
    seen.add(ch)
    out.push(ch)
  }
  return out
}

/**
 * 页面上的格子阵列。唯一的输入是「每行几格」：
 * 格子边长 = 可用宽度 ÷ 列数，横向正好铺满；纵向能塞几行是几行，剩下的边距上下平分。
 */
export type Shape = { cols: number; rows: number; cell: number; x: number; y: number }

export function shapeOf(cfg: Config): Shape {
  const cols = Math.max(1, Math.round(cfg.cols))
  const cell = (A4.w - 2 * cfg.marginMm) / cols
  const rows = Math.max(1, Math.floor((A4.h - 2 * cfg.marginMm) / cell))
  return { cols, rows, cell, x: cfg.marginMm, y: (A4.h - rows * cell) / 2 }
}

/**
 * 一格里画什么：
 *   'ink'   全黑范字，照着看的，不用描
 *   数字 n  写到第 n 笔的样子，整个字都浅灰，可以描
 *   'blank' 空格，自己写
 * 整页只有一条规则：浅灰的就描，黑的不用动。
 */
type Slot = 'ink' | 'blank' | number

/**
 * 一个字排成若干页的格子序列：
 * 黑范字 → 每格多一笔 → 3 个整字（同一个灰）→ 剩下全是空格，自己写。
 * 整字固定 3 个，不跟着页面大小变 —— 描完就该自己写了，多描没意义。
 * 一页只排一个字 —— 翻页就是换字。
 */
function planSlots(strokeCount: number, shape: Shape, cfg: Config): Slot[][] {
  const per = shape.cols * shape.rows
  const seq: Slot[] = [
    'ink',
    ...Array.from({ length: strokeCount }, (_, i) => i + 1),
    ...Array.from({ length: cfg.fullCount }, () => strokeCount),
  ]

  const pages: Slot[][] = []
  for (let i = 0; i < seq.length; i += per) pages.push(seq.slice(i, i + per))

  const last = pages[pages.length - 1]
  while (last.length < per) last.push('blank')

  return pages
}

function gridPrims(shape: Shape, cfg: Config): Prim[] {
  const { cols, rows, cell, x, y } = shape
  const { frame, inner } = GRID_COLORS[cfg.gridColor]
  // 小格子上原尺寸的线宽和虚线会显得糊
  const k = Math.min(1, Math.max(0.5, cell / 50))
  const dash = [DASH[0] * k, DASH[1] * k] as const
  const out: Prim[] = []

  if (cfg.gridType !== 'square') {
    const w = INNER_W * k
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cx = x + c * cell
        const cy = y + r * cell
        out.push({ kind: 'line', x1: cx, y1: cy + cell / 2, x2: cx + cell, y2: cy + cell / 2, w, color: inner, dash })
        out.push({ kind: 'line', x1: cx + cell / 2, y1: cy, x2: cx + cell / 2, y2: cy + cell, w, color: inner, dash })
        if (cfg.gridType === 'mi') {
          out.push({ kind: 'line', x1: cx, y1: cy, x2: cx + cell, y2: cy + cell, w, color: inner, dash })
          out.push({ kind: 'line', x1: cx + cell, y1: cy, x2: cx, y2: cy + cell, w, color: inner, dash })
        }
      }
    }
  }

  const fw = FRAME_W * k
  for (let r = 0; r <= rows; r++) {
    out.push({ kind: 'line', x1: x, y1: y + r * cell, x2: x + cols * cell, y2: y + r * cell, w: fw, color: frame })
  }
  for (let c = 0; c <= cols; c++) {
    out.push({ kind: 'line', x1: x + c * cell, y1: y, x2: x + c * cell, y2: y + rows * cell, w: fw, color: frame })
  }
  return out
}

function slotPrims(shape: Shape, idx: number, slot: Slot, strokes: string[], cfg: Config): Prim[] {
  if (slot === 'blank') return []
  const cx = shape.x + (idx % shape.cols) * shape.cell
  const cy = shape.y + Math.floor(idx / shape.cols) * shape.cell
  const m = glyphMatrix(cx, cy, shape.cell, cfg.glyphRatio)

  const g = cfg.traceDarkness
  const fill: RGB = slot === 'ink' ? INK : [g, g, g]
  const use = slot === 'ink' ? strokes : strokes.slice(0, slot)
  return use.map((s) => ({ kind: 'path' as const, d: transformPath(s, m), fill }))
}

export type Page = { char: string; index: number; total: number; prims: Prim[] }

export function planPages(chars: string[], data: Map<string, CharData>, cfg: Config): Page[] {
  const shape = shapeOf(cfg)
  const grid = gridPrims(shape, cfg)
  const pages: Page[] = []

  for (const char of chars) {
    const entry = data.get(char)
    if (!entry) continue
    const sheets = planSlots(entry.strokes.length, shape, cfg)
    sheets.forEach((slots, i) => {
      const prims = [...grid]
      slots.forEach((slot, idx) => prims.push(...slotPrims(shape, idx, slot, entry.strokes, cfg)))
      pages.push({ char, index: i + 1, total: sheets.length, prims })
    })
  }
  return pages
}
