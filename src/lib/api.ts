// llama-server client. The server must allow the page's origin (llama-server answers CORS by default).

export interface ModelInfo {
  id: string
  status?: string // router mode only: loaded, loading, unloaded
}

export async function listModels(server: string): Promise<ModelInfo[]> {
  const res = await fetch(`${server}/v1/models`)
  if (!res.ok) throw new Error(`models: HTTP ${res.status}`)
  const data = await res.json()
  return (data.data || []).map((m: { id: string; status?: { value?: string } }) => ({ id: m.id, status: m.status?.value }))
}

export interface DecisionField {
  value: unknown
  probability: number
  scored_nodes: number
  tree: boolean
  interval_p10_p90?: unknown[]
}

export interface DecisionResponse {
  decision: Record<string, unknown>
  fields: Record<string, DecisionField>
  usage: { prompt_tokens: number; cached_tokens: number; context_tokens: number; scored_rows: number }
  timings: { prefill_ms: number; scoring_ms: number; total_ms: number; rounds: number }
}

export interface ApiRequest {
  url: string
  body: Record<string, unknown>
}

async function errorText(res: Response): Promise<string> {
  const text = await res.text()
  try {
    return JSON.parse(text).error?.message || text
  } catch {
    return text || res.statusText
  }
}

export async function decide(req: ApiRequest, signal?: AbortSignal): Promise<DecisionResponse> {
  const res = await fetch(req.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req.body),
    signal,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await errorText(res)}`)
  return res.json()
}

export interface ChatTimings {
  prompt_n?: number
  prompt_ms?: number
  predicted_n?: number
  predicted_ms?: number
  predicted_per_second?: number
}

export interface ChatResult {
  content: string
  timings: ChatTimings | null
  usage: { prompt_tokens?: number; completion_tokens?: number } | null
}

// Streams a chat completion; onDelta gets each content / reasoning piece as it arrives.
export async function streamChat(
  req: ApiRequest,
  onDelta: (content: string, reasoning: string) => void,
  signal?: AbortSignal,
): Promise<ChatResult> {
  const res = await fetch(req.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req.body),
    signal,
  })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}: ${await errorText(res)}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const out: ChatResult = { content: '', timings: null, usage: null }
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') continue
      let msg
      try {
        msg = JSON.parse(payload)
      } catch {
        continue
      }
      if (msg.error) throw new Error(msg.error.message || 'stream error')
      if (msg.timings) out.timings = msg.timings
      if (msg.usage) out.usage = msg.usage
      const delta = msg.choices?.[0]?.delta || {}
      const piece = delta.content || ''
      const reason = delta.reasoning_content || ''
      if (piece || reason) {
        out.content += piece
        onDelta(piece, reason)
      }
    }
  }
  return out
}
