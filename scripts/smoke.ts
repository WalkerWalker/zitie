/** 本地烟测：不经浏览器直接出一份 PDF，用来检查笔画落位、方向和缩放。 */
import { writeFile } from 'node:fs/promises'
import { DEFAULTS, normalizeChars, planPages, shapeOf, type Config } from '../src/layout.ts'
import { get, loadChars, type CharData } from '../src/strokeData.ts'
import { buildPdf } from '../src/renderPdf.ts'

const input = process.argv[2] ?? '大水'
const out = process.argv[3] ?? '/tmp/zitie-smoke.pdf'
// 第三个参数可以覆盖任意配置，例：npm run smoke -- 水 /tmp/a.pdf '{"cols":4,"gridType":"mi"}'
const cfg: Config = { ...DEFAULTS, ...(process.argv[4] ? JSON.parse(process.argv[4]) : {}) }

const chars = normalizeChars(input)
const missing = await loadChars(chars)
if (missing.length) console.warn('字库里没有:', missing.join(' '))

const data = new Map<string, CharData>()
for (const char of chars) {
  const entry = get(char)
  if (entry) data.set(char, entry)
}
const pages = planPages(chars, data, cfg)

const shape = shapeOf(cfg)
console.log(
  `每行 ${shape.cols} 格 · ${shape.cell.toFixed(1)}mm · ${shape.cols}×${shape.rows} = ${shape.cols * shape.rows} 格/页 · ${pages.length} 页`,
)
for (const [char, entry] of data) console.log(`  ${char}: ${entry.strokes.length} 笔`)

await writeFile(out, await buildPdf(pages))
console.log('写入', out)
