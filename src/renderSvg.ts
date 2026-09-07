import { A4, type Prim, type RGB } from './layout.ts'

const css = (c: RGB) => `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`

/** viewBox 单位就是毫米，图元坐标可以直接用。 */
export function pageToSvg(prims: Prim[]): string {
  const body = prims
    .map((p) => {
      if (p.kind === 'path') return `<path d="${p.d}" fill="${css(p.fill)}"/>`
      const dash = p.dash ? ` stroke-dasharray="${p.dash.join(' ')}"` : ''
      return `<line x1="${p.x1}" y1="${p.y1}" x2="${p.x2}" y2="${p.y2}" stroke="${css(p.color)}" stroke-width="${p.w}"${dash}/>`
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${A4.w} ${A4.h}" preserveAspectRatio="xMidYMid meet"><rect width="${A4.w}" height="${A4.h}" fill="#fff"/>${body}</svg>`
}
