import { PDFDocument, rgb } from 'pdf-lib'
import { A4, type Page } from './layout.ts'

const MM = 72 / 25.4

/**
 * 全矢量输出，且完全不用嵌入中文字体 —— 汉字是笔画轮廓路径，不是文字。
 * pdf-lib 的 drawSvgPath 做的是 translate(x,y) → scale(s,-s)，
 * 所以 {x:0, y:页高, scale:MM} 正好把「毫米、y 向下、原点左上」的路径落到正确位置。
 */
export async function buildPdf(pages: Page[], title = '字帖'): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.setTitle(title)
  doc.setCreator('zitie')

  const w = A4.w * MM
  const h = A4.h * MM

  for (const page of pages) {
    const pdfPage = doc.addPage([w, h])
    for (const prim of page.prims) {
      if (prim.kind === 'path') {
        pdfPage.drawSvgPath(prim.d, {
          x: 0,
          y: h,
          scale: MM,
          color: rgb(prim.fill[0], prim.fill[1], prim.fill[2]),
        })
      } else {
        pdfPage.drawLine({
          start: { x: prim.x1 * MM, y: h - prim.y1 * MM },
          end: { x: prim.x2 * MM, y: h - prim.y2 * MM },
          thickness: prim.w * MM,
          color: rgb(prim.color[0], prim.color[1], prim.color[2]),
          dashArray: prim.dash ? prim.dash.map((v) => v * MM) : undefined,
        })
      }
    }
  }
  return doc.save()
}
