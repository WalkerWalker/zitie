/**
 * 数字字帖：直接出 PDF，不经浏览器 —— 页面上暂时没这个入口。
 *
 *   npm run numbers                                  # 1-10 → /tmp/zitie-numbers.pdf
 *   npm run numbers -- 1-100 ~/Downloads/数字.pdf
 *   npm run numbers -- 1-20 /tmp/a.pdf '{"cols":5}'
 */
import { writeFile } from 'node:fs/promises'
import { DEFAULTS, planNumberPages, shapeOf, type Config } from '../src/layout.ts'
import { DIGIT_PATHS } from '../src/digits.ts'
import { buildPdf } from '../src/renderPdf.ts'

const range = process.argv[2] ?? '1-10'
const out = process.argv[3] ?? '/tmp/zitie-numbers.pdf'
// 数字页默认**田字格**：米字格的斜线是用来摆撇捺的，数字没有斜笔画用不上，
// 反倒跟浅灰的数字抢眼 —— 数字瘦，盖不住底下的斜线，汉字宽所以没这个问题。
const cfg: Config = { ...DEFAULTS, gridType: 'tian', ...(process.argv[4] ? JSON.parse(process.argv[4]) : {}) }

const m = range.match(/^(\d+)(?:-(\d+))?$/)
if (!m) {
  console.error(`看不懂的范围「${range}」，要的是 5 或者 1-100 这种`)
  process.exit(1)
}
const from = Number(m[1])
const to = m[2] ? Number(m[2]) : from
if (to < from) {
  console.error(`范围反了：${from}-${to}`)
  process.exit(1)
}

const numbers = Array.from({ length: to - from + 1 }, (_, i) => from + i)
const pages = planNumberPages(numbers, DIGIT_PATHS, cfg)

const shape = shapeOf(cfg)
const widest = Math.max(...numbers.map((n) => String(n).length))
console.log(
  `每行 ${shape.cols} 格 · ${shape.cell.toFixed(1)}mm · ${shape.cols}×${shape.rows} = ${shape.cols * shape.rows} 格/页 · ` +
    `${numbers.length} 个数 · ${pages.length} 页`,
)
console.log(`  一行一个数，最宽 ${widest} 位 → 一行放得下 ${Math.floor(shape.cols / widest)} 个`)
pages.forEach((p, i) => console.log(`  第 ${i + 1} 页: ${p.label}`))

await writeFile(out, await buildPdf(pages))
console.log('写入', out)
