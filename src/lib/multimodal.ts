// Multimodal input for /v1/chat/completions. llama-server takes media as typed content parts of a
// message, so a picked file becomes one or more parts. Which media a model accepts is reported
// either by /props (single-model server) or by /v1/models architecture (router mode).

export interface Modalities {
  vision: boolean
  audio: boolean
  video: boolean
}

export const NO_MODALITIES: Modalities = { vision: false, audio: false, video: false }

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'input_audio'; input_audio: { data: string; format: string } }
  | { type: 'input_video'; input_video: { data: string; format: string } }

export type AttachmentKind = 'image' | 'audio' | 'video' | 'pdf' | 'text'

export interface Attachment {
  id: string
  name: string
  size: number
  kind: AttachmentKind
  parts: ContentPart[]
  note: string // short summary on the chip
  error?: string // set when the model cannot take this file, or it could not be read
}

const MAX_MB = 20
const MAX_TEXT = 200_000
const MAX_PDF_PAGES = 12
const PDF_MAX_WIDTH = 1200 // pixels; vision encoders downscale far below this anyway

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tga']
const AUDIO_EXT = ['wav', 'mp3', 'flac', 'ogg', 'oga', 'm4a', 'aac', 'opus']
const VIDEO_EXT = ['mp4', 'webm', 'mov', 'mkv', 'avi']
const TEXT_EXT = [
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'xml', 'html', 'htm', 'svg',
  'css', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cc', 'cpp', 'h', 'hpp',
  'sh', 'ps1', 'sql', 'log', 'ini', 'toml', 'cfg', 'conf', 'env', 'srt', 'vtt',
]
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', tga: 'image/x-tga' }

const ext = (name: string) => name.slice(name.lastIndexOf('.') + 1).toLowerCase()

// --- capability detection ---

const parse = (v: unknown): Modalities | null => {
  if (!v || typeof v !== 'object') return null
  const m = v as Record<string, unknown>
  if (!('vision' in m || 'audio' in m || 'video' in m)) return null
  return { vision: !!m.vision, audio: !!m.audio, video: !!m.video }
}

export async function fetchModalities(server: string, model: string): Promise<Modalities> {
  // single-model server: /props reports the loaded model's media support
  try {
    const res = await fetch(`${server}/props`)
    if (res.ok) {
      const m = parse((await res.json())?.modalities)
      if (m) return m
    }
  } catch {
    /* older server or no CORS: fall through to the model list */
  }
  // router mode: every /v1/models entry carries architecture.input_modalities
  try {
    const res = await fetch(`${server}/v1/models`)
    if (res.ok) {
      const list: { id?: string; architecture?: { input_modalities?: string[] } }[] = (await res.json())?.data || []
      const inputs = list.find((x) => x.id === model)?.architecture?.input_modalities
      if (inputs) return { vision: inputs.includes('image'), audio: inputs.includes('audio'), video: inputs.includes('video') }
    }
  } catch {
    /* treat as text only */
  }
  return NO_MODALITIES
}

export const mediaLabel = (m: Modalities) =>
  [m.vision && 'images', m.audio && 'audio', m.video && 'video'].filter(Boolean).join(' · ')

// --- files to content parts ---

function classify(file: File): AttachmentKind | null {
  const t = file.type
  const e = ext(file.name)
  if (t === 'image/svg+xml' || e === 'svg') return 'text' // XML really, and not a format mtmd can decode
  if (t === 'application/pdf' || e === 'pdf') return 'pdf'
  if (t.startsWith('image/') || IMAGE_EXT.includes(e)) return 'image'
  if (t.startsWith('audio/') || AUDIO_EXT.includes(e)) return 'audio'
  if (t.startsWith('video/') || VIDEO_EXT.includes(e)) return 'video'
  if (t.startsWith('text/') || t === 'application/json' || t === 'application/xml' || TEXT_EXT.includes(e)) return 'text'
  return null
}

const supported = (kind: AttachmentKind, m: Modalities) => {
  if (kind === 'image' || kind === 'pdf') return m.vision
  if (kind === 'audio') return m.audio
  if (kind === 'video') return m.video
  return true // text goes through the chat template on any model
}

const toBase64 = (buf: ArrayBuffer) => {
  const bytes = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

// Rasterises each page to a JPEG; llama.cpp has no PDF decoder, its own web UI does the same.
async function pdfToImages(file: File): Promise<{ parts: ContentPart[]; note: string }> {
  const pdfjs = await import('pdfjs-dist')
  pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) })
  const doc = await task.promise
  const pages = Math.min(doc.numPages, MAX_PDF_PAGES)
  const parts: ContentPart[] = []
  for (let p = 1; p <= pages; p++) {
    const page = await doc.getPage(p)
    const scale = Math.min(2, PDF_MAX_WIDTH / page.getViewport({ scale: 1 }).width)
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    await page.render({ canvas, viewport }).promise
    parts.push({ type: 'image_url', image_url: { url: canvas.toDataURL('image/jpeg', 0.82) } })
    page.cleanup()
  }
  const total = doc.numPages
  await task.destroy()
  return { parts, note: total > pages ? `pdf · ${pages} of ${total} pages` : `pdf · ${pages} page${pages > 1 ? 's' : ''}` }
}

export async function buildAttachment(file: File, modalities: Modalities): Promise<Attachment> {
  const base: Omit<Attachment, 'kind'> = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, name: file.name, size: file.size, parts: [], note: '' }
  const kind = classify(file)
  if (!kind) return { ...base, kind: 'text', error: 'unsupported file type' }
  const media = kind === 'pdf' ? 'image' : kind
  if (!supported(kind, modalities)) return { ...base, kind, error: `model has no ${media} input` }
  if (file.size > MAX_MB * 1024 * 1024) return { ...base, kind, error: `too large (max ${MAX_MB} MB)` }
  try {
    if (kind === 'text') {
      const text = (await file.text()).slice(0, MAX_TEXT)
      return { ...base, kind, parts: [{ type: 'text', text: `\n\n--- ${file.name} ---\n${text}` }], note: text.length >= MAX_TEXT ? 'text · truncated' : 'text' }
    }
    if (kind === 'pdf') return { ...base, kind, ...(await pdfToImages(file)) }
    const data = toBase64(await file.arrayBuffer())
    if (kind === 'image') return { ...base, kind, parts: [{ type: 'image_url', image_url: { url: `data:${file.type || MIME[ext(file.name)] || 'image/png'};base64,${data}` } }], note: 'image' }
    if (kind === 'audio') return { ...base, kind, parts: [{ type: 'input_audio', input_audio: { data, format: ext(file.name) } }], note: 'audio' }
    return { ...base, kind, parts: [{ type: 'input_video', input_video: { data, format: ext(file.name) } }], note: 'video' }
  } catch (e) {
    return { ...base, kind, error: `could not read: ${(e as Error).message}` }
  }
}

// The user message stays a plain string until a file adds media, so text-only requests do not change.
export function contentParts(context: string, attachments: Attachment[]): string | ContentPart[] {
  const media = attachments.filter((a) => !a.error).flatMap((a) => a.parts)
  if (!media.length) return context
  return context ? [{ type: 'text', text: context }, ...media] : media
}

// --- files to /v1/decision contexts ---

const partsOf = <T extends ContentPart['type']>(list: Attachment[], type: T) =>
  list.flatMap((a) => a.parts.filter((p): p is Extract<ContentPart, { type: T }> => p.type === type))

/**
 * /v1/decision takes a context as a string or an array of parts, with any number of text, image_url
 * and input_audio parts (video has no mtmd chunk type; send frames as images). Attachments are one
 * list for the whole request: text goes into every context, and the media goes into every context
 * too - except when the media parts pair up with the contexts one to one (N images or a PDF's pages
 * with N contexts separated by ---), which stays one part per context. That is the gallery case.
 */
export interface DecisionContexts {
  contexts: (string | ContentPart[])[]
  note: string // what the Request tab says about the attachments
}

export function decisionContexts(contexts: string[], attachments: Attachment[]): DecisionContexts {
  const live = attachments.filter((a) => !a.error)
  const texts = partsOf(live, 'text')
  const media = live.flatMap((a) => a.parts.filter((p) => p.type === 'image_url' || p.type === 'input_audio'))
  const videos = partsOf(live, 'input_video').length
  const paired = media.length > 1 && media.length === contexts.length

  const bits: string[] = []
  if (paired) bits.push(`${media.length} media parts, one per context`)
  else if (media.length) bits.push(`${media.length} media part${media.length > 1 ? 's' : ''}${contexts.length > 1 ? ' with every context' : ''}`)
  else if (texts.length) bits.push('text attachment')
  if (videos) bits.push('video dropped (chat only)')
  if (!media.length && !texts.length) return { contexts, note: bits.join(' · ') }

  return {
    contexts: contexts.map((ctx, i) => {
      const parts: ContentPart[] = []
      if (ctx) parts.push({ type: 'text', text: ctx })
      parts.push(...texts)
      parts.push(...(paired ? [media[i]] : media))
      return parts
    }),
    note: bits.join(' · '),
  }
}

// Request previews replace base64 blobs, which are far too large to print.
export function shrinkPayload(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.startsWith('data:') && value.length > 128) return `${value.slice(0, value.indexOf(','))},<${kb(value.length * 0.75)}>`
    if (value.length > 512 && /^[A-Za-z0-9+/=]+$/.test(value.slice(0, 64))) return `<base64, ${kb(value.length * 0.75)}>`
    return value
  }
  if (Array.isArray(value)) return value.map(shrinkPayload)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shrinkPayload(v)]))
  return value
}

const kb = (bytes: number) => (bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`)
