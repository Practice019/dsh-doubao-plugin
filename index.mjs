import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'

export const name = 'doubao-relay-web-search'
export const inject = ['tools', 'systemPrompt', 'llm']

const RELAY_URL = 'http://127.0.0.1:56666/v1/chat/completions'
const DEFAULT_SYSTEM =
  'You are a helpful web search assistant. Provide accurate, current, and concise answers with sources if possible.'
const DEFAULT_TIMEOUT_MS = 90000
const MAX_TIMEOUT_MS = 120000

/** 本地识图图片超过该字节数时自动压缩（512KB 以上即压缩——实测 Relay 对 2MB+ 的 base64 载荷就会挂起）。 */
const MAX_LOCAL_BYTES = 512 * 1024
/** 压缩后最大宽度（保持原比例）。 */
const DOWNSCALE_MAX_WIDTH = 800
const POWERSHELL_CANDIDATES = ['powershell.exe', 'pwsh.exe', 'pwsh']
const execFileAsync = promisify(execFile)

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.heif': 'image/heif'
}

/**
* 用 PowerShell + System.Drawing 把本地图片压缩到 DOWNSCALE_MAX_WIDTH 宽（保持比例），
* 输出统一为 JPEG（PNG 截图压缩率差，800px PNG 仍可达 1.6MB，base64 后会让 Relay 挂起；
* JPEG 约 200KB，远离挂起阈值）。失败时抛错，由调用方回退原图。
* @param srcPath - 本地图片绝对路径。
* @returns 压缩后的临时文件路径。
*/
async function downscaleImage(srcPath) {
  const dstPath = join(tmpdir(), `dsh-img-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`)
  const script = [
    'Add-Type -AssemblyName System.Drawing',
    'try {',
    '  $img = [System.Drawing.Image]::FromFile($env:DSH_SRC)',
    `  $scale = [math]::Min(1.0, ${DOWNSCALE_MAX_WIDTH} / $img.Width)`,
    '  $newW = [int]($img.Width * $scale)',
    '  $newH = [int]($img.Height * $scale)',
    '  $bmp = New-Object System.Drawing.Bitmap($newW, $newH)',
    '  $g = [System.Drawing.Graphics]::FromImage($bmp)',
    '  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
    '  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality',
    '  $g.DrawImage($img, 0, 0, $newW, $newH)',
    '  $bmp.Save($env:DSH_DST, [System.Drawing.Imaging.ImageFormat]::Jpeg)',
    '  $g.Dispose(); $bmp.Dispose(); $img.Dispose()',
    '  exit 0',
    '} catch {',
    '  Write-Error $_.Exception.Message',
    '  exit 1',
    '}'
  ].join('\n')
  let lastError
  for (const shell of POWERSHELL_CANDIDATES) {
    try {
      await execFileAsync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], {
        env: { ...process.env, DSH_SRC: srcPath, DSH_DST: dstPath },
        timeout: 60000,
        windowsHide: true
      })
      return dstPath
    } catch (error) {
      lastError = error
      if (error && error.code !== 'ENOENT') break
    }
  }
  throw lastError || new Error('no powershell available')
}

/**
* 把 image 参数解析成 Relay 可用的图片引用：
* http(s) URL / data URL 原样透传；本地文件路径读入后转 base64 data URL（多模态识图用）。
* 本地图片过大（> MAX_LOCAL_BYTES）时自动压缩到 800px 宽再发送，防止豆包识图卡死；
* 压缩失败则回退原图。
*/
async function resolveImageInput(image) {
  const trimmed = String(image).trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (trimmed.startsWith('data:')) return trimmed

  let path = trimmed
  let tempPath
  try {
    const info = await stat(path)
    if (info.isFile() && info.size > MAX_LOCAL_BYTES) {
      try {
        tempPath = await downscaleImage(path)
        path = tempPath
        console.log(`[doubao-relay] image downscaled for vision: ${trimmed} -> ${tempPath}`)
      } catch (error) {
        console.log('[doubao-relay] image downscale failed, sending original: ' + (error && error.message ? error.message : String(error)))
      }
    }
    const buffer = await readFile(path)
    const mime = MIME_BY_EXT[extname(path).toLowerCase()] ?? 'image/jpeg'
    return `data:${mime};base64,${buffer.toString('base64')}`
  } finally {
    if (tempPath) {
      try {
        await unlink(tempPath)
      } catch {
        // 临时文件清理失败可忽略
      }
    }
  }
}

// ==== 粘贴图片保存为路径（paste-to-path）====
// 直接复用 modlens（@liustack/modlens）验证过的实现：浏览器半部分（client.js）在捕获阶段
// 拦截图片粘贴，先向本路由 GET 询问"当前选中模型是否纯文本"（verdict，host 用真实模型元数据
// 判定），确认后 preventDefault 并 POST 字节到本路由；文件落为私有临时文件，返回的路径文本
// 插入输入框。文本模型看到路径而非图片附件，模型再把路径传给 doubao_ask 的 image
// 参数即可让豆包识图。过期文件随每次新粘贴按年龄+总量清扫。
// Image magic bytes for the paste route: refuse anything that is not a real
// image before a byte touches disk. Mirrors modlens's sniffing table.
const PASTE_SNIFFS = [
  {
    ext: '.png',
    test: (b) =>
      b.length >= 8 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a
  },
  { ext: '.jpg', test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    ext: '.gif',
    test: (b) => b.length >= 6 && ['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6))
  },
  {
    ext: '.webp',
    test: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP'
  },
  {
    ext: '.heic',
    test: (b) =>
      b.length >= 12 &&
      b.toString('ascii', 4, 8) === 'ftyp' &&
      ['heic', 'heix', 'hevc', 'hevx'].includes(b.toString('ascii', 8, 12))
  },
  {
    ext: '.heif',
    test: (b) =>
      b.length >= 12 &&
      b.toString('ascii', 4, 8) === 'ftyp' &&
      ['mif1', 'msf1', 'heif'].includes(b.toString('ascii', 8, 12))
  }
]
const PASTE_MAX_BYTES = 25 * 1024 * 1024

/**
 * Should the browser take a paste over for the model behind this selector
 * label? Decided here, not in the browser, because only the host holds the
 * structured model metadata. The answer is true only when EVERY model whose
 * name or id appears in the label is positively confirmed text-only; any
 * image-capable match, unknown modality, or unreadable catalog vetoes the
 * takeover (the native paste stays). Our plugin registers no vision wrapper,
 * so the own-provider carve-out of modlens is not needed.
 */
async function pasteTakeoverVerdict(host, label) {
  if (typeof label !== 'string' || label.trim() === '') return false
  const llm = host.llm
  if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
    return false
  }
  const lowered = label.toLowerCase()
  let matchedAny = false
  for (const info of llm.listProviders()) {
    const providerId = info?.id
    if (!providerId) continue
    let models = []
    try {
      models = await llm.listModels(providerId)
    } catch {
      return false
    }
    for (const model of models) {
      for (const candidate of [model?.name, model?.id]) {
        if (typeof candidate !== 'string' || candidate.length === 0) continue
        if (!lowered.includes(candidate.toLowerCase())) continue
        const modalities = model?.inputModalities
        if (!Array.isArray(modalities) || modalities.includes('image')) {
          return false
        }
        if (candidate.length >= 3) {
          matchedAny = true
        }
      }
    }
  }
  return matchedAny
}

// Verdicts are stable for the lifetime of a model route but the inventory can
// grow (llm-pi-ai mounts after settings load), so cache briefly, not forever.
const PASTE_VERDICT_TTL_MS = 15_000
const PASTE_VERDICT_CAP = 32

/**
 * The paste route. POST /doubao-paste: image bytes in, `{ path }` out; the
 * file is private (0600) in a fresh unpredictable temp dir, magic-byte
 * checked and size-capped. GET /doubao-paste?model=<selector label>:
 * `{ takeover }`: the browser half asks before ever touching a paste, so a
 * disabled route (no web profile) means the client stands down instead of
 * swallowing pastes into a 404. Bound to the dsh web server, which listens
 * on loopback by default.
 */
function registerPasteRoute(ctx, host) {
  const verdicts = new Map()
  // Topology changes empty the cache at exactly the boundary that invalidates
  // it (a route mounting mid-TTL could otherwise serve a stale verdict).
  let topologyEpoch = 0
  if (typeof host.on === 'function') {
    host.on('llm/adapters-updated', () => {
      topologyEpoch += 1
      verdicts.clear()
    })
  }
  ctx.webServer.register({
    name: 'doubao-paste',
    kind: 'exact',
    path: '/doubao-paste',
    handler: async (req, res) => {
      if (req.method === 'GET') {
        try {
          const label = new URL(req.url, 'http://localhost').searchParams.get('model') ?? ''
          const cached = verdicts.get(label)
          let takeover
          if (cached && Date.now() - cached.at < PASTE_VERDICT_TTL_MS) {
            takeover = cached.takeover
          } else {
            let attempts = 0
            for (;;) {
              const startedEpoch = topologyEpoch
              takeover = await pasteTakeoverVerdict(host, label)
              if (topologyEpoch === startedEpoch) {
                verdicts.delete(label)
                verdicts.set(label, { takeover, at: Date.now() })
                if (verdicts.size > PASTE_VERDICT_CAP) {
                  verdicts.delete(verdicts.keys().next().value)
                }
                break
              }
              attempts += 1
              if (attempts >= 3) {
                takeover = false
                break
              }
            }
          }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ takeover }))
        } catch (error) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: String(error?.message ?? error) }))
        }
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      try {
        const chunks = []
        let total = 0
        for await (const chunk of req) {
          total += chunk.length
          if (total > PASTE_MAX_BYTES) {
            res.writeHead(413, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: `image over the ${PASTE_MAX_BYTES}-byte limit` }))
            req.destroy()
            return
          }
          chunks.push(chunk)
        }
        const buffer = Buffer.concat(chunks)
        const sniff = PASTE_SNIFFS.find((s) => s.test(buffer))
        if (!sniff) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'not a recognized image (png/jpeg/gif/webp/heic)' }))
          return
        }
        const { mkdtemp, writeFile } = await import('node:fs/promises')
        const { join } = await import('node:path')
        const root = await openPasteRoot()
        const dir = await mkdtemp(join(root, 'p-'))
        const file = join(dir, `paste${sniff.ext}`)
        await writeFile(file, buffer, { mode: 0o600 })
        // This one cannot be deleted when the request ends: its path is what
        // goes into the composer, so the file has to outlive the response and
        // survive until the model reads it. Expired ones are swept here (the
        // same moment a paste already costs a disk write), fire and forget.
        lastPasteSweep = sweepExpiredPastes(Date.now())
        void lastPasteSweep
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ path: file }))
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: String(error?.message ? error.message : error) }))
      }
    }
  })
}

/**
 * How long a pasted file stays reachable. A week errs the way this asymmetry
 * asks for: the path leaves through the composer as plain text, so nothing
 * observes whether the draft holding it was sent, cleared, or abandoned.
 */
const PASTE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** A ceiling on what unread pastes may hold, independent of age. */
const PASTE_STORE_MAX_BYTES = 1024 * 1024 * 1024

/** The most recent sweep, so tests can await what production does not. */
let lastPasteSweep = Promise.resolve()

/** Everything this plugin writes for pastes lives under one directory. */
function pasteRoot(base = null) {
  return base ?? join(tmpdir(), 'doubao-dsh-paste')
}

/**
 * Open the store directory, or refuse it. The path is predictable and the
 * system temp directory is shared, so a symlink planted at that name would
 * point cleanup elsewhere; an existing entry must be a real directory this
 * user owns, and a new one is created private.
 */
async function openPasteRoot(base = null) {
  const { mkdir, lstat, chmod, realpath } = await import('node:fs/promises')
  const { basename, dirname } = await import('node:path')
  const root = pasteRoot(base)
  const parent = dirname(root)
  await mkdir(parent, { recursive: true }).catch(() => {})
  let realParent
  try {
    realParent = await realpath(parent)
  } catch (error) {
    throw new Error(`${parent} is not usable for the paste store: ${error?.message ?? error}`)
  }
  const target = join(realParent, basename(root))
  try {
    await mkdir(target, { mode: 0o700 })
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw error
    }
  }
  const info = await lstat(target)
  if (!info.isDirectory()) {
    throw new Error(`${target} exists and is not a directory`)
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (uid !== undefined) {
    if (info.uid !== uid) {
      throw new Error(`${target} belongs to another user`)
    }
    if ((info.mode & 0o777) !== 0o700) {
      await chmod(target, 0o700)
      const after = await lstat(target)
      if ((after.mode & 0o777) !== 0o700) {
        throw new Error(`${target} could not be made private`)
      }
    }
  }
  return target
}

/**
 * Remove pastes that have expired, then, if what remains is still too large,
 * the oldest until it is not. Only ever looks inside our own directory.
 */
async function sweepExpiredPastes(now = Date.now(), base = null, maxBytes = PASTE_STORE_MAX_BYTES) {
  try {
    const { readdir, stat, rm } = await import('node:fs/promises')
    const root = pasteRoot(base)
    const kept = []
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const full = join(root, entry.name)
      try {
        const info = await stat(full)
        if (now - info.mtimeMs >= PASTE_TTL_MS) {
          try {
            await rm(full, { recursive: true, force: true })
            continue
          } catch {
            // Held open, or removed only in part.
          }
        }
        const bytes = await directorySize(full).catch(() => PASTE_MAX_BYTES)
        kept.push({ full, mtimeMs: info.mtimeMs, bytes })
      } catch {
        // Vanished between listing and measuring. A paste must never fail
        // over housekeeping.
      }
    }
    let total = kept.reduce((sum, item) => sum + item.bytes, 0)
    if (total <= maxBytes) return
    for (const item of kept.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (total <= maxBytes) break
      try {
        await rm(item.full, { recursive: true, force: true })
        total -= item.bytes
      } catch {
        // Still held, or gone only in part. Measure what is actually left.
        total -= item.bytes - (await directorySize(item.full).catch(() => item.bytes))
      }
    }
  } catch {
    // No directory yet, or no listing available. The paste itself worked.
  }
}

/** What a paste directory occupies, or a throw when that cannot be known. */
async function directorySize(dir) {
  const { readdir, stat } = await import('node:fs/promises')
  let bytes = 0
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    try {
      bytes += (await stat(join(dir, entry.name))).size
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
  }
  return bytes
}

export function apply(ctx) {
  ctx.systemPrompt.section({
    name: 'doubao-web-search',
    order: 115,
    text:
      '当用户需要联网搜索或获取实时信息（例如最新新闻、热映电影、天气、股价、赛事等）时，' +
      '优先调用 doubao_ask 工具，通过豆包获取联网搜索结果；不要使用内置 web_search。' +
      '当用户需要生成图片（画图、配图、表情包、头像、壁纸等任何图片生成需求）时，' +
      '同样优先调用 doubao_ask 工具，豆包会生成图片并以 markdown 图片链接的形式返回。' +
      '当用户提供图片要求识别、描述、分析（多模态识图）时，也调用 doubao_ask 工具，' +
      '并把 image 参数设为该图片的 URL 或本地文件路径，豆包会识图并以文字回答。' +
      '多张图片时：把所有图片的 URL/路径用换行分隔一并填入 image 参数（或传字符串数组），' +
      '豆包会逐一识别。' +
      '用户粘贴的图片会被保存为本地文件路径（形如 C:\\Users\\...\\doubao-dsh-paste\\...\\paste.png）' +
      '并以纯文本形式插入消息（多张图每行一个路径）；需要查看或识别这类图片时，同样调用 doubao_ask，' +
      '把 image 参数设为该路径（多张图用换行分隔）。' +
      '工具返回的 content 字段就是豆包的完整回答。回复用户时，必须把 content 的完整内容原样呈现：' +
      '不得总结、不得删减、不得只摘要点、不得遗漏任何条目、数据或细节；' +
      '把完整信息直接转述给用户，而不是自己重新归纳。' +
      '如果豆包返回了图片（content 中以 ![描述](图片链接) 形式出现的 markdown 图片），' +
      '回复时必须原样保留这些图片链接，让图片能在对话中直接显示出来。'
  })

  // 原生 raw 定义注册（不依赖任何 dsh 包，可发布到 npm 后他人环境直接解析）：
  // parameters/output.schema 均为标准 JSON Schema，与 defineTool 生成的线上形状一致。
  ctx.tools.register({
    name: 'doubao_ask',
    description:
      'Doubao 联网搜索 / 图片生成 / 多模态识图工具。当用户需要联网搜索、获取实时信息、' +
      '最新新闻、热搜、即将/正在热映的电影、天气、股价、赛事等内容，或需要生成图片' +
      '（画图、配图、表情包、头像、壁纸等），或提供图片要求识别/描述/分析（多模态识图）时，' +
      '可以调用本工具；它通过本地 Doubao Relay 获取豆包的联网搜索结果、生成图片或识图。' +
      '生成图片时，豆包会把图片以 markdown 图片链接的形式放在返回内容里；' +
      '识图时把图片放在 image 参数里，豆包返回文字描述。',

    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '要搜索、询问或要求识图分析的问题。'
        },
        image: {
          type: 'string',
          description: '可选：要识别/分析的图片——http(s) 图片 URL、base64 data URL，或本地图片文件路径（本地图超过约 512KB 会自动压缩后发送）。多张图用换行分隔多个 URL/路径，或传字符串数组，豆包会逐一识别。'
        },
        system: {
          type: 'string',
          description: '可选：额外的系统指令，用于控制回答风格或格式。'
        },
        new_conversation: {
          type: 'boolean',
          description: '可选：是否强制新建豆包对话。默认 true；多轮上下文需要延续时可设为 false。'
        },
        timeoutMs: {
          type: 'number',
          description: '可选：超时时间，单位毫秒，默认 90000。'
        }
      },
      required: ['query']
    },

    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: {
            type: 'string',
            description: '豆包返回的回答内容。'
          },
          requestId: { type: 'string' },
          status: { type: 'integer' },
          usage: { type: 'object', additionalProperties: true },
          images: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                url: { type: 'string' },
                alt: { type: 'string' }
              }
            }
          },
          log: { type: 'string' }
        }
      },
      render(_args, value) {
        return [{ type: 'text', text: value.content }]
      }
    },

    async execute(args, exec) {
      const query = String(args.query || '').trim()
      if (!query) {
        throw new Error('query is required')
      }

      const newConversation = args.new_conversation !== false
      const system = args.system ? String(args.system) : DEFAULT_SYSTEM

      // 多模态识图：image 参数支持单图或多图——传字符串数组，或字符串内用换行分隔
      // 多个 URL/路径。逐张解析（本地大图自动压缩），全部转成 OpenAI 兼容的
      // 多 image_url content 数组发给豆包，豆包逐一识别后返回文字。
      const rawImage = args.image
      let imageInputs = []
      if (Array.isArray(rawImage)) {
        imageInputs = rawImage.filter((item) => typeof item === 'string' && item.trim().length > 0)
      } else if (typeof rawImage === 'string' && rawImage.trim().length > 0) {
        imageInputs = rawImage
          .split(/\r?\n/)
          .map((item) => item.trim())
          .filter(Boolean)
      }
      let userContent = query
      if (imageInputs.length > 0) {
        try {
          const imageRefs = []
          for (const input of imageInputs) {
            imageRefs.push(await resolveImageInput(input))
          }
          userContent = [
            { type: 'text', text: query },
            ...imageRefs.map((url) => ({ type: 'image_url', image_url: { url } }))
          ]
        } catch (error) {
          throw new Error('无法读取图片（' + imageInputs.join(' | ') + '）：' + (error && error.message ? error.message : String(error)))
        }
      }

      const payload = {
        model: 'doubao-chat',
        new_conversation: newConversation,
        stream: false,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userContent }
        ]
      }

      const timeoutMs = Math.min(Number(args.timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const onSignal = () => controller.abort()

      let logRecord
      try {
        if (exec.signal?.addEventListener) {
          exec.signal.addEventListener('abort', onSignal, { once: true })
        }

        let response
        try {
          response = await fetch(RELAY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify(payload),
            signal: controller.signal
          })
        } catch (err) {
          logRecord = {
            timestamp: new Date().toISOString(),
            tool: 'doubao_ask',
            phase: 'request',
            request: { query, system, new_conversation: newConversation, stream: false },
            aborted: controller.signal.aborted,
            error: err && err.message ? err.message : String(err)
          }
          console.log('[doubao-relay] ' + JSON.stringify(logRecord))
          throw new Error('Doubao Relay request failed: ' + JSON.stringify(logRecord))
        }

        const raw = await response.text()
        if (!response.ok) {
          logRecord = {
            timestamp: new Date().toISOString(),
            tool: 'doubao_ask',
            phase: 'http',
            request: { query, system, new_conversation: newConversation, stream: false },
            response: { status: response.status, body: raw.slice(0, 2000) }
          }
          console.log('[doubao-relay] ' + JSON.stringify(logRecord))
          throw new Error('Doubao Relay returned HTTP ' + response.status + ': ' + raw.slice(0, 2000))
        }

        let json
        try {
          json = JSON.parse(raw)
        } catch (e) {
          throw new Error('Doubao Relay returned non-JSON: ' + raw.slice(0, 2000))
        }

        let content =
          json &&
          json.choices &&
          json.choices[0] &&
          json.choices[0].message &&
          json.choices[0].message.content

        if (typeof content !== 'string') {
          throw new Error('Doubao Relay response missing content: ' + raw.slice(0, 2000))
        }

        // Doubao 会把流式搜索过程噪音（"正在搜索找到 N 篇资料…"/识图时的"正在搜索图片找到 N 张图片…"）
        // 拼在回答开头，剥离这段前置噪音，让完整回答更干净；剥离后为空则保留原文（不丢信息）。
        const cleaned = content.replace(/^(?:正在搜索)?(?:找到\s*\d+\s*篇资料|图片找到\s*\d+\s*张图片)+/, '')
        if (cleaned.trim().length > 0) {
          content = cleaned
        }

        // 接收图片：豆包生成的图片以 markdown 链接（![描述](url)）形式返回。
        // 同一张图常带多个 CDN 镜像/模板变体（水印/预览/原图等），按图片路径（~tplv 之前）分组，
        // 每组选最优变体（image_raw 原图 > 无水印变体 > 其余），再把内容里该图的所有变体链接
        // 统一替换为最优链接；无法接收的非 http(s) 占位链接（豆包的文件名占位）直接剔除。
        const imageRank = (url) => {
          if (url.includes('image_raw')) return 2
          if (!/(^|[-_])wm([-_]|$)|watermark/i.test(url)) return 1
          return 0
        }
        const variantsByBase = new Map()
        const imagePattern = /!\[([^\]]*)\]\(([^)]+)\)/g
        let imageMatch
        while ((imageMatch = imagePattern.exec(content)) !== null) {
          const alt = imageMatch[1]
          const url = imageMatch[2]
          if (!/^https?:\/\//i.test(url)) continue
          let base = url
          try {
            const parsed = new URL(url)
            const templateIndex = parsed.pathname.indexOf('~tplv')
            base = templateIndex > 0 ? parsed.pathname.slice(0, templateIndex) : parsed.pathname
          } catch {
            // URL 解析失败时保留整条 URL 作为去重键
          }
          if (!variantsByBase.has(base)) variantsByBase.set(base, [])
          variantsByBase.get(base).push({ url, alt })
        }
        const variantMap = new Map()
        const images = []
        for (const [base, variants] of variantsByBase) {
          let best = variants[0]
          for (const candidate of variants) {
            if (imageRank(candidate.url) > imageRank(best.url)) best = candidate
          }
          for (const candidate of variants) variantMap.set(candidate.url, best.url)
          images.push({ url: best.url, alt: best.alt })
        }
        if (images.length > 0) {
          let replaced = content
          for (const [variant, canonical] of variantMap) {
            if (variant !== canonical) {
              replaced = replaced.split(variant).join(canonical)
            }
          }
          // 剔除无法接收的非 http(s) 图片链接（豆包的文件名占位）
          replaced = replaced.replace(/!\[[^\]]*\]\(([^)]+)\)/g, (whole, linkUrl) =>
            /^https?:\/\//i.test(linkUrl) ? whole : ''
          )
          // 折叠独立的重复图片行（保留每种 canonical 链接首次出现）
          const seenImageLines = new Set()
          replaced = replaced.split('\n').filter((line) => {
            const trimmed = line.trim()
            if (!/^!\[[^\]]*\]\([^)]+\)$/.test(trimmed)) return true
            if (seenImageLines.has(trimmed)) return false
            seenImageLines.add(trimmed)
            return true
          }).join('\n')
          content = replaced
        }

        logRecord = {
          timestamp: new Date().toISOString(),
          tool: 'doubao_ask',
          request: {
            query,
            system,
            new_conversation: newConversation,
            stream: false,
            model: payload.model,
            has_image: imageInputs.length > 0,
            image_count: imageInputs.length
          },
          response: { status: response.status }
        }

        console.log('[doubao-relay] ' + JSON.stringify(logRecord))

        const result = {
          content,
          requestId: typeof json.id === 'string' ? json.id : '',
          status: typeof json.status === 'number' && Number.isInteger(json.status) ? json.status : 200,
          log: JSON.stringify(logRecord)
        }
        if (json.usage !== null && typeof json.usage === 'object' && !Array.isArray(json.usage)) {
          result.usage = json.usage
        }
        if (images.length > 0) {
          result.images = images
        }
        return result
      } finally {
        clearTimeout(timer)
        if (exec.signal?.removeEventListener) {
          exec.signal.removeEventListener('abort', onSignal)
        }
      }
    }
  })

  // 粘贴图片→路径：webServer 仅 web profile 存在，用可选注入挂载；无 web 环境则跳过。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => {
      try {
        registerPasteRoute(scope, ctx)
      } catch (error) {
        console.error('[doubao] paste route skipped: ' + (error && error.message ? error.message : String(error)))
      }
    })
  }
}
