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

/** 页面切成的横块，一块放一个字。row0 是起始行。 */
type Band = { row0: number; rows: number }

/**
 * 一页横着切成几块，一块放一个字 —— 格子调小之后一页有七八十格，
 * 一个字撑不满，空得太厉害。
 *
 * 块数没有写死，也不是一个选项：切到「最矮的那块还装得下这批字里最难的那个字」为止。
 * 一个字要占的是自己的全部格子，再加至少一整行空的 —— 不然没地方自己写。
 * 于是简单的字排得密、笔画多的字排得松，而同一份里每页结构完全一样。
 *
 * 行数除不尽时余下的行给靠后的块（上面的矮、下面的高）。
 * 每行 7 格 = 10 行、一般的字切三块，正好是 3 / 3 / 4。
 */
function bandsOf(shape: Shape, maxSeq: number): Band[] {
  const need = maxSeq + shape.cols // 全部格子 + 一整行空的
  let k = 1
  for (let n = shape.rows; n > 1; n--) {
    if (Math.floor(shape.rows / n) * shape.cols >= need) {
      k = n
      break
    }
  }

  const base = Math.floor(shape.rows / k)
  const extra = shape.rows % k
  const bands: Band[] = []
  for (let i = 0, row0 = 0; i < k; i++) {
    const rows = base + (i >= k - extra ? 1 : 0)
    bands.push({ row0, rows })
    row0 += rows
  }
  return bands
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

/** label 是预览用的标题，一页两个字就是两个字。 */
export type Page = { chars: string[]; label: string; prims: Prim[] }

/**
 * 按顺序把字填进「块」，一块一个字。块的高度是按这批字里最难的那个算的，
 * 所以除非一整页都装不下（笔画特别多、格子特别大），每个字都放得进自己那一块。
 */
export function planPages(chars: string[], data: Map<string, CharData>, cfg: Config): Page[] {
  const shape = shapeOf(cfg)
  const grid = gridPrims(shape, cfg)
  const per = shape.cols * shape.rows

  const seqs = new Map<string, Slot[]>()
  for (const char of chars) {
    const entry = data.get(char)
    if (entry) seqs.set(char, seqOf(entry.strokes.length, cfg))
  }
  const bands = bandsOf(shape, Math.max(0, ...[...seqs.values()].map((s) => s.length)))

  type Sheet = { chars: string[]; labels: string[]; cells: Cell[] }
  const sheets: Sheet[] = []
  // 大于等于 bands.length 表示「这页用完了」，下一个字得开新页
  let band = bands.length

  const open = (): Sheet => {
    const sheet: Sheet = { chars: [], labels: [], cells: Array<Cell>(per).fill(null) }
    sheets.push(sheet)
    band = 0
    return sheet
  }
  const put = (at: number, seq: Slot[], char: string, label: string) => {
    const sheet = sheets[sheets.length - 1]
    seq.forEach((slot, i) => (sheet.cells[at + i] = { char, slot }))
    sheet.chars.push(char)
    sheet.labels.push(label)
  }

  for (const char of chars) {
    const seq = seqs.get(char)
    if (!seq) continue

    if (band >= bands.length) open()
    const b = bands[band]

    if (seq.length <= b.rows * shape.cols) {
      put(b.row0 * shape.cols, seq, char, char)
      band++
      continue
    }

    // 只有「一整页都装不下」才会走到这儿。前面的块已经写了字就先翻页
    if (band > 0) open()
    const parts = Math.ceil(seq.length / per)
    for (let i = 0; i < parts; i++) {
      if (i > 0) open()
      put(0, seq.slice(i * per, (i + 1) * per), char, parts > 1 ? `${char} ${i + 1}/${parts}` : char)
    }
    band = bands.length
  }

  return sheets.map((sheet) => {
    const prims = [...grid]
    sheet.cells.forEach((cell, idx) => {
      if (cell) prims.push(...slotPrims(shape, idx, cell.slot, data.get(cell.char)!.strokes, cfg))
    })
    return { chars: sheet.chars, label: sheet.labels.join('　'), prims }
  })
}
