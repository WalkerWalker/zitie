import { DEFAULTS, normalizeChars, planPages, shapeOf, type Config, type Page } from './layout.ts'
import { get, loadChars, type CharData } from './strokeData.ts'
import { pageToSvg } from './renderSvg.ts'
import { buildPdf } from './renderPdf.ts'

const LS_KEY = 'zitie.v5'
const MAX_PREVIEW = 12

/**
 * 界面上只剩「每行几格」一个旋钮 —— 这本来就是做这个网站的理由。
 * 格子大小是算出来的（可用宽度 ÷ 列数），所以横向永远正好铺满一页；
 * 挑「几格」比拖毫米好决定：选项就这几个，每一个都是一张能直接印的纸。
 * 页边距、字占格子、田字格、灰格线、末尾空行、描红深浅全部定死在 layout.ts 的 DEFAULTS 里，
 * 想试别的值走 `npm run smoke -- 字 out.pdf '{"glyphRatio":0.8}'`，不占界面。
 */
const COLS = [3, 4, 5, 6, 7, 8]

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T

function loadSaved(): { text: string; cfg: Config } {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) {
      // 只认界面上调得动的那个键，定死的值永远以 DEFAULTS 为准，改了立刻生效
      const s = JSON.parse(raw) as { text?: string; cfg?: Partial<Config> }
      const cfg = { ...DEFAULTS }
      if (COLS.includes(s.cfg?.cols as number)) cfg.cols = s.cfg!.cols as number
      return { text: s.text ?? '', cfg }
    }
  } catch {
    // 存档坏了就用默认值
  }
  return { text: '日月水火大小人口', cfg: { ...DEFAULTS } }
}

const saved = loadSaved()
let text = saved.text
const cfg = saved.cfg
let pages: Page[] = []
let missing: string[] = []
let refreshToken = 0

const charsInput = $<HTMLTextAreaElement>('#chars')
const preview = $('#preview')
const info = $('#info')
const charnote = $('#charnote')
const downloadBtn = $<HTMLButtonElement>('#download')

charsInput.value = text

function buildControls() {
  const row = document.createElement('div')
  row.className = 'field'

  const name = document.createElement('span')
  name.textContent = '每行几格'
  const value = document.createElement('em')
  name.append(value)

  const chips = document.createElement('div')
  chips.className = 'chips'
  const buttons = COLS.map((n) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = String(n)
    b.addEventListener('click', () => {
      cfg.cols = n
      paintChips()
      refresh()
    })
    chips.append(b)
    return b
  })

  const paintChips = () => {
    const s = shapeOf(cfg)
    value.textContent = `${s.cell.toFixed(1)}mm · ${s.cols} × ${s.rows} = ${s.cols * s.rows} 格`
    buttons.forEach((b, i) => b.classList.toggle('on', COLS[i] === cfg.cols))
  }
  paintChips()

  row.append(name, chips)
  $('#controls').append(row)
}

function persist() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ text, cfg }))
  } catch {
    // 无痕模式下写不了，无所谓
  }
}

async function refresh() {
  const token = ++refreshToken
  const chars = normalizeChars(text)
  missing = await loadChars(chars)
  if (token !== refreshToken) return

  const data = new Map<string, CharData>()
  for (const ch of chars) {
    const entry = get(ch)
    if (entry) data.set(ch, entry)
  }
  pages = planPages(chars, data, cfg)
  persist()
  paint()
}

function paint() {
  info.textContent = pages.length ? `共 ${pages.length} 页` : ''
  charnote.textContent = missing.length ? `字库里没有：${missing.join(' ')}` : ''
  downloadBtn.disabled = pages.length === 0

  const shown = pages.slice(0, MAX_PREVIEW)
  const sheets = shown.map((p) => {
    const label = p.total > 1 ? `${p.char} ${p.index}/${p.total}` : p.char
    return `<figure class="paper"><div class="page">${pageToSvg(p.prims)}</div><figcaption>${label}</figcaption></figure>`
  })
  if (pages.length > shown.length) {
    sheets.push(`<p class="more">还有 ${pages.length - shown.length} 页没预览，下载的 PDF 是完整的</p>`)
  }
  preview.innerHTML = sheets.join('') || '<p class="more">输入几个汉字试试</p>'
}

async function download() {
  downloadBtn.disabled = true
  const label = downloadBtn.textContent
  downloadBtn.textContent = '生成中…'
  try {
    const bytes = await buildPdf(pages)
    const chars = [...new Set(pages.map((p) => p.char))]
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `字帖-${chars.slice(0, 6).join('')}${chars.length > 6 ? '等' : ''}.pdf`
    a.click()
    URL.revokeObjectURL(url)
  } finally {
    downloadBtn.textContent = label
    downloadBtn.disabled = pages.length === 0
  }
}

let typing: ReturnType<typeof setTimeout> | undefined
charsInput.addEventListener('input', () => {
  text = charsInput.value
  clearTimeout(typing)
  typing = setTimeout(refresh, 250)
})
downloadBtn.addEventListener('click', download)

buildControls()
refresh()
