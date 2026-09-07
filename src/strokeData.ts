export type CharData = {
  strokes: string[]
  medians: number[][][]
}

const DATA_VERSION = '2.0.1'
const CDN = `https://cdn.jsdelivr.net/npm/hanzi-writer-data@${DATA_VERSION}`

const cache = new Map<string, CharData | null>()
const inflight = new Map<string, Promise<CharData | null>>()

async function fetchJson(url: string): Promise<CharData | null> {
  const res = await fetch(url)
  if (!res.ok) return null
  const json = (await res.json()) as Partial<CharData>
  if (!Array.isArray(json.strokes) || json.strokes.length === 0) return null
  return { strokes: json.strokes, medians: json.medians ?? [] }
}

/** 先走 dev server 从 node_modules 直读，失败再回落到 CDN。 */
async function fetchChar(char: string): Promise<CharData | null> {
  const name = `${encodeURIComponent(char)}.json`
  try {
    const local = await fetchJson(`/hanzi/${name}`)
    if (local) return local
  } catch {
    // 相对路径在 Node 里会抛，交给 CDN
  }
  try {
    return await fetchJson(`${CDN}/${name}`)
  } catch {
    return null
  }
}

export function get(char: string): CharData | null | undefined {
  return cache.get(char)
}

/** 拉取所有还没缓存的字；返回字库里查不到的那些。 */
export async function loadChars(chars: string[]): Promise<string[]> {
  await Promise.all(
    chars.map((char) => {
      if (cache.has(char)) return
      let job = inflight.get(char)
      if (!job) {
        job = fetchChar(char).then((data) => {
          cache.set(char, data)
          inflight.delete(char)
          return data
        })
        inflight.set(char, job)
      }
      return job
    }),
  )
  return chars.filter((char) => !cache.get(char))
}
