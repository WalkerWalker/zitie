import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'

const dataDir = path.dirname(createRequire(import.meta.url).resolve('hanzi-writer-data/package.json'))

/**
 * 把 node_modules 里的 9574 个笔画 JSON 按需喂给浏览器。
 * 不打包（32MB）、不依赖 CDN。生产构建下 strokeData.ts 会自动回落到 jsDelivr。
 */
function hanziData(): Plugin {
  const prefix = '/hanzi/'
  return {
    name: 'hanzi-data',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith(prefix)) return next()
        const name = decodeURIComponent(req.url.slice(prefix.length).split('?')[0])
        const file = path.join(dataDir, name)
        if (!name.endsWith('.json') || path.dirname(file) !== dataDir) {
          res.statusCode = 400
          res.end('bad request')
          return
        }
        readFile(file).then(
          (buf) => {
            res.setHeader('Content-Type', 'application/json')
            res.setHeader('Cache-Control', 'max-age=31536000, immutable')
            res.end(buf)
          },
          () => {
            res.statusCode = 404
            res.end('{}')
          },
        )
      })
    },
  }
}

export default defineConfig({
  // GitHub Pages 的项目页在 /zitie/ 下，资源路径要带上这一段
  base: '/zitie/',
  plugins: [hanziData()],
})
