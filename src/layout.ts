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
  cols: 7,
  marginMm: 11,
  glyphRatio: 0.72,
  gridType: 'mi',
  gridColor: 'gray',
  traceDarkness: 0.82,
  fullCount: 3,
}

/**
 * 层次必须是：黑范字 > 浅灰的字 > 格子虚线。
 * 注意 inner 的灰值比描红的 0.82 还深一点，但虚线细、又是断的，看上去仍然退在字后面 ——
 * 这里比的是「视觉分量」不是 RGB。真按 RGB 排（比描红更淡）米字格就淡到看不见了。
 */
const GRID_COLORS: Record<GridColor, { frame: RGB; inner: RGB }> = {
  gray: { frame: [0.6, 0.64, 0.7], inner: [0.74, 0.77, 0.82] },
  red: { frame: [0.87, 0.55, 0.55], inner: [0.9, 0.68, 0.68] },
  green: { frame: [0.5, 0.72, 0.57], inner: [0.7, 0.85, 0.75] },
}

/** 纯黑打印偏重，深灰更接近铅笔范字 */
const INK: RGB = [0.1, 0.1, 0.11]

const FRAME_W = 0.35
const INNER_W = 0.25
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
 * 排不到的格子就是空的（下面的 Cell = null），自己写。
 * 整页只有一条规则：浅灰的就描，黑的不用动。
 */
type Slot = 'ink' | number

/**
 * 一个字要占的格子序列：黑范字 → 每格多一笔 → 3 个整字（同一个灰）。
 * 整字固定 3 个，不跟着页面大小变 —— 描完就该自己写了，多描没意义。
 */
function seqOf(strokeCount: number, cfg: Config): Slot[] {
  return [
    'ink',
    ...Array.from({ length: strokeCount }, (_, i) => i + 1),
    ...Array.from({ length: cfg.fullCount }, () => strokeCount),
  ]
}

/** 一格的内容；null 就是空格。 */
type Cell = { char: string; slot: Slot } | null

function gridPrims(shape: Shape, cfg: Config): Prim[] {
  const { cols, rows, cell, x, y } = shape
  const { frame, inner } = GRID_COLORS[cfg.gridColor]
  // 小格子上原尺寸的线宽和虚线会显得糊。基准是 50mm，默认的 37.6mm 格子上 k = 0.75，
  // 也就是上面那些线宽和虚线长度实际都要再打个七五折 —— 调 INNER_W 的时候记着这一层。
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
  const cx = shape.x + (idx % shape.cols) * shape.cell
  const cy = shape.y + Math.floor(idx / shape.cols) * shape.cell
  const m = glyphMatrix(cx, cy, shape.cell, cfg.glyphRatio)

  const g = cfg.traceDarkness
  const fill: RGB = slot === 'ink' ? INK : [g, g, g]
  const use = slot === 'ink' ? strokes : strokes.slice(0, slot)
  return use.map((s) => ({ kind: 'path' as const, d: transformPath(s, m), fill }))
}

/** label 是预览用的标题。 */
export type Page = { chars: string[]; label: string; prims: Prim[] }

/**
 * 按顺序一字至少两行，所以十行最多五字、九行最多四字。
 * 笔画多的字再占足够的行；剩余行从后往前分给各字。
 */
export function planPages(chars: string[], data: Map<string, CharData>, cfg: Config): Page[] {
  const shape = shapeOf(cfg)
  const grid = gridPrims(shape, cfg)
  const per = shape.cols * shape.rows
  const maxBands = Math.max(1, Math.floor(shape.rows / 2))
  type Sheet = { chars: string[]; labels: string[]; cells: Cell[] }
  const sheets: Sheet[] = []
  const open = (): Sheet => {
    const sheet: Sheet = { chars: [], labels: [], cells: Array<Cell>(per).fill(null) }
    sheets.push(sheet)
    return sheet
  }
  const put = (sheet: Sheet, at: number, seq: Slot[], char: string, label: string) => {
    seq.forEach((slot, i) => (sheet.cells[at + i] = { char, slot }))
    sheet.chars.push(char)
    sheet.labels.push(label)
  }

  type Pending = { char: string; seq: Slot[]; rows: number }
  let pending: Pending[] = []
  let usedRows = 0
  const flush = () => {
    if (!pending.length) return
    const sheet = open()
    const heights = pending.map((item) => item.rows)
    // 空行给靠后的字，默认 7×10 且五个短笔画字时就是 2 / 2 / 2 / 2 / 2。
    for (let i = 0; i < shape.rows - usedRows; i++) {
      heights[pending.length - 1 - (i % pending.length)]++
    }
    let row0 = 0
    pending.forEach((item, i) => {
      put(sheet, row0 * shape.cols, item.seq, item.char, item.char)
      row0 += heights[i]
    })
    pending = []
    usedRows = 0
  }

  for (const char of chars) {
    const entry = data.get(char)
    if (!entry) continue
    const seq = seqOf(entry.strokes.length, cfg)
    const rows = Math.max(2, Math.ceil(seq.length / shape.cols))

    if (rows > shape.rows) {
      flush()
      const parts = Math.ceil(seq.length / per)
      for (let i = 0; i < parts; i++) {
        const sheet = open()
        put(sheet, 0, seq.slice(i * per, (i + 1) * per), char, parts > 1 ? `${char} ${i + 1}/${parts}` : char)
      }
      continue
    }
    if (pending.length === maxBands || usedRows + rows > shape.rows) flush()
    pending.push({ char, seq, rows })
    usedRows += rows
  }
  flush()

  return sheets.map((sheet) => {
    const prims = [...grid]
    sheet.cells.forEach((cell, idx) => {
      if (cell) prims.push(...slotPrims(shape, idx, cell.slot, data.get(cell.char)!.strokes, cfg))
    })
    return { chars: sheet.chars, label: sheet.labels.join('　'), prims }
  })
}

/**
 * 数字页：**一行一个数**，跟汉字页是两套排法。
 *
 * 汉字要拆笔顺，所以一个字要占一长串格子、一页只放得下几个；
 * 数字没有笔顺可拆（字库里也根本没有阿拉伯数字，字形是 `scripts/gen-digits.py` 从字体抠的），
 * 一个数就是一格，横着排一行正好。于是每行 7 格 = 10 行，1-10 正好一页。
 *
 * 多位数一位占一格：`10` 占两格，一行放得下几个**整数**就放几个
 * —— 半个数不能印，所以 7 格只放得下 3 个「10」，剩的那格空着。
 */
export function planNumberPages(numbers: number[], digits: Record<string, string>, cfg: Config): Page[] {
  const shape = shapeOf(cfg)
  const grid = gridPrims(shape, cfg)
  const pages: Page[] = []

  for (let i = 0; i < numbers.length; i += shape.rows) {
    const rows = numbers.slice(i, i + shape.rows)
    const prims = [...grid]

    rows.forEach((n, r) => {
      const text = String(n)
      const fit = Math.floor(shape.cols / text.length)
      // 跟汉字那边同一个道理：描几个就够了，剩下的格子留着自己写（fit - 2 就是留出这一个空的）。
      // 但**至少要有一个能描的** —— 位数一多就放不下几个了，
      // 7 格排「100」只放得下两个，宁可不留空也不能整行只剩个黑范字、没地方下笔。
      const traces = fit >= 2 ? Math.max(1, Math.min(cfg.fullCount, fit - 2)) : 0

      for (let copy = 0; copy <= traces; copy++) {
        for (let d = 0; d < text.length; d++) {
          const idx = r * shape.cols + copy * text.length + d
          // 第一个是黑范字，后面的浅灰可描 —— 整页仍然只有那一条规则
          prims.push(...slotPrims(shape, idx, copy === 0 ? 'ink' : 1, [digits[text[d]]], cfg))
        }
      }
    })

    const label = rows.length > 1 ? `${rows[0]} – ${rows[rows.length - 1]}` : String(rows[0])
    pages.push({ chars: rows.map(String), label, prims })
  }

  return pages
}
