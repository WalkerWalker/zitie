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

/** 半页至少要这么多行，不然还是一页一个字。 */
const MIN_BAND_ROWS = 4

/** 页面切成的横块，一块放一个字。row0 是起始行。 */
type Band = { row0: number; rows: number }

/**
 * 一页上下各放一个字 —— 每行 7 格有 10 行，一个字撑不满，空得太厉害。
 * 但半页矮到只有 3 行就不值得切了：笔顺排完剩不下几格空的，还不如整页给一个字。
 * 所以每行 6 / 7 / 8 格（半页 4–6 行）切两半，3 / 4 / 5 格不切。
 * 行数是奇数时多出来的那行给下半页 —— 上半少、下半多。
 */
function bandsOf(shape: Shape): Band[] {
  const top = Math.floor(shape.rows / 2)
  if (top < MIN_BAND_ROWS) return [{ row0: 0, rows: shape.rows }]
  return [
    { row0: 0, rows: top },
    { row0: top, rows: shape.rows - top },
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

/** label 是预览用的标题，一页两个字就是两个字。 */
export type Page = { chars: string[]; label: string; prims: Prim[] }

/**
 * 按顺序把字填进「块」：能占半页就占半页，占不下就独占一整页，
 * 一整页还装不下（笔画特别多）就接着往下翻页。
 */
export function planPages(chars: string[], data: Map<string, CharData>, cfg: Config): Page[] {
  const shape = shapeOf(cfg)
  const grid = gridPrims(shape, cfg)
  const bands = bandsOf(shape)
  const per = shape.cols * shape.rows

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
    const entry = data.get(char)
    if (!entry) continue
    const seq = seqOf(entry.strokes.length, cfg)

    if (band >= bands.length) open()
    const b = bands[band]

    // 半页要装得下「这个字的全部格子 + 至少一整行空的」，不然不值得挤
    if (bands.length > 1 && seq.length <= (b.rows - 1) * shape.cols) {
      put(b.row0 * shape.cols, seq, char, char)
      band++
      continue
    }

    // 独占整页。上半页已经写了字就先翻页
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
