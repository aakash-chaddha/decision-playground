import { useEffect, useMemo, useRef, useState } from 'react'
import { decide, streamChat, type ApiRequest, type ChatTimings, type DecisionResponse } from '../lib/api'
import { toJsonSchema } from '../lib/schema'
import { useSettings } from '../lib/settings'
import { PRESETS } from '../playground/presets'
import { SchemaEditor } from '../components/SchemaEditor'
import { Stopwatch, type StopwatchHandle } from '../components/Stopwatch'
import { useSplit } from '../components/Gutter'
import { ModelSelect, useModelChoice, useModels } from '../components/ModelSelect'

const STORE = 'decision-playground.request'

interface Inputs {
  preset: string
  instructions: string
  schema: string
  context: string
}

function presetInputs(id: string): Inputs {
  const p = PRESETS.find((x) => x.id === id) || PRESETS[0]
  return { preset: p.id, instructions: p.instructions, schema: JSON.stringify(p.schema, null, 2), context: p.context }
}

function loadInputs(): Inputs {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || 'null')
    if (saved?.schema != null) return saved
  } catch {
    /* fall through to the first preset */
  }
  return presetInputs(PRESETS[0].id)
}

interface Options {
  mode: string
  cache: boolean
  maxTokens: number
  temperature: number
  grammar: boolean
  thinking: boolean
}

interface RunState {
  status: string
  running: boolean
  roundTrip: number | null
  server: number | null
  error: string
}
const idleRun: RunState = { status: 'idle', running: false, roundTrip: null, server: null, error: '' }
const n = (v: number | null | undefined, d = 0) => (v == null || Number.isNaN(v) ? '–' : v.toFixed(d))

export function Playground() {
  const { server } = useSettings()
  const { models, error: modelError, refresh } = useModels()
  const [model, setModel] = useModelChoice('playground', models)
  const [inputs, setInputs] = useState<Inputs>(loadInputs)
  const [opts, setOpts] = useState<Options>({ mode: 'auto', cache: true, maxTokens: 1024, temperature: 0, grammar: true, thinking: false })

  const [dec, setDec] = useState<RunState>(idleRun)
  const [decResult, setDecResult] = useState<DecisionResponse | null>(null)
  const [llm, setLlm] = useState<RunState>(idleRun)
  const [llmText, setLlmText] = useState({ content: '', reasoning: '' })
  const [llmStats, setLlmStats] = useState<{ ttft: number | null; tokens: number; timings: ChatTimings | null; promptTokens?: number }>({
    ttft: null,
    tokens: 0,
    timings: null,
  })
  const [llmJson, setLlmJson] = useState<Record<string, unknown> | null>(null)
  const [sent, setSent] = useState<{ dec: ApiRequest | null; llm: ApiRequest | null }>({ dec: null, llm: null })
  const [view, setView] = useState<{ dec: 'out' | 'req'; llm: 'out' | 'req' }>({ dec: 'out', llm: 'out' })
  const [busy, setBusy] = useState(false)

  const decTimer = useRef<StopwatchHandle>(null)
  const llmTimer = useRef<StopwatchHandle>(null)
  const abort = useRef<AbortController | null>(null)
  const llmOut = useRef<HTMLPreElement>(null)

  const left = useSplit({ key: 'left', axis: 'x', min: 18, max: 60, step: 2 }, '--left')
  const cards = useSplit({ key: 'cards', axis: 'x', min: 20, max: 80, step: 2 }, '--dec')
  const top = useSplit({ key: 'top', axis: 'y', min: 120, max: (p) => p.clientHeight - 140, step: 20 }, '--top')

  useEffect(() => {
    try {
      localStorage.setItem(STORE, JSON.stringify(inputs))
    } catch {
      /* not remembered */
    }
  }, [inputs])

  // Any change to what would be sent turns the Request tabs back into previews.
  useEffect(() => setSent({ dec: null, llm: null }), [inputs, opts, model, server])

  const update = (patch: Partial<Inputs>) => setInputs((cur) => ({ ...cur, ...patch, preset: 'custom' }))
  const blurb = PRESETS.find((p) => p.id === inputs.preset)?.blurb || 'Your own request.'

  const schemaObj = useMemo(() => {
    try {
      return { value: JSON.parse(inputs.schema) as Record<string, unknown>, error: '' }
    } catch (e) {
      return { value: null, error: (e as Error).message }
    }
  }, [inputs.schema])

  const decisionRequest = (): ApiRequest => ({
    url: `${server}/v1/decision`,
    body: { model, instructions: inputs.instructions, context: inputs.context, schema: schemaObj.value, mode: opts.mode, cache_prompt: opts.cache },
  })
  const llmRequest = (): ApiRequest => {
    const jsonSchema = toJsonSchema(schemaObj.value!)
    const instr = inputs.instructions.trim()
    const system =
      (instr ? instr + '\n\n' : '') +
      'Answer with one JSON object that matches this JSON Schema. Output only the JSON object.\n' +
      JSON.stringify(jsonSchema, null, 2)
    const body: Record<string, unknown> = {
      model,
      stream: true,
      max_tokens: opts.maxTokens || 1024,
      temperature: opts.temperature,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: inputs.context },
      ],
      chat_template_kwargs: { enable_thinking: opts.thinking },
      stream_options: { include_usage: true },
    }
    if (opts.grammar) body.response_format = { type: 'json_schema', json_schema: { name: 'decision', schema: jsonSchema, strict: true } }
    return { url: `${server}/v1/chat/completions`, body }
  }

  const isCold = (list = models) => list.find((m) => m.id === model)?.status === 'unloaded'

  async function runDecision(signal: AbortSignal) {
    const req = decisionRequest()
    const cold = isCold()
    setSent((s) => ({ ...s, dec: req }))
    setDecResult(null)
    setDec({ ...idleRun, running: true, status: cold ? 'loading model…' : 'deciding…' })
    decTimer.current?.start()
    try {
      const data = await decide(req, signal)
      const wall = decTimer.current!.stop()
      decTimer.current!.showServer(data.timings.total_ms)
      setDecResult(data)
      setDec({
        running: false,
        roundTrip: wall,
        server: data.timings.total_ms,
        error: '',
        status: `done · round trip ${Math.round(wall)} ms${cold ? ' incl. load' : ''}${data.usage.cached_tokens ? '' : ' · cold cache'}`,
      })
    } catch (e) {
      decTimer.current?.stop()
      const aborted = (e as Error).name === 'AbortError'
      setDec({ ...idleRun, status: aborted ? 'stopped' : 'error', error: aborted ? '' : (e as Error).message })
    }
  }

  async function runLlm(signal: AbortSignal, cold = isCold()) {
    const req = llmRequest()
    setSent((s) => ({ ...s, llm: req }))
    setLlmJson(null)
    setLlmText({ content: '', reasoning: '' })
    setLlmStats({ ttft: null, tokens: 0, timings: null })
    setLlm({ ...idleRun, running: true, status: cold ? 'loading model…' : 'waiting for first token…' })
    llmTimer.current?.start()
    let ttft: number | null = null
    let chunks = 0
    try {
      const result = await streamChat(
        req,
        (piece, reason) => {
          if (ttft == null) {
            ttft = llmTimer.current!.elapsed()
            setLlm((s) => ({ ...s, status: 'streaming…' }))
          }
          chunks++
          setLlmText((t) => ({ content: t.content + piece, reasoning: t.reasoning + reason }))
          setLlmStats((s) => ({ ...s, ttft, tokens: chunks }))
          requestAnimationFrame(() => llmOut.current && (llmOut.current.scrollTop = llmOut.current.scrollHeight))
        },
        signal,
      )
      const wall = llmTimer.current!.stop()
      const t = result.timings
      const serverMs = t?.prompt_ms != null && t?.predicted_ms != null ? t.prompt_ms + t.predicted_ms : null
      if (serverMs != null) llmTimer.current!.showServer(serverMs)
      let parsed: Record<string, unknown> | null = null
      try {
        parsed = JSON.parse(result.content.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''))
      } catch {
        parsed = null
      }
      setLlmJson(parsed)
      setLlmStats({ ttft, tokens: t?.predicted_n ?? result.usage?.completion_tokens ?? chunks, timings: t, promptTokens: t?.prompt_n ?? result.usage?.prompt_tokens })
      setLlm({
        running: false,
        roundTrip: wall,
        server: serverMs,
        error: '',
        status: `done · round trip ${Math.round(wall)} ms${cold ? ' incl. load' : ''}${parsed ? '' : ' · not valid JSON'}`,
      })
    } catch (e) {
      llmTimer.current?.stop()
      const aborted = (e as Error).name === 'AbortError'
      setLlm({ ...idleRun, status: aborted ? 'stopped' : 'error', error: aborted ? '' : (e as Error).message })
    }
  }

  async function run(which: 'dec' | 'llm' | 'both') {
    if (!schemaObj.value || busy) return
    const controller = new AbortController()
    abort.current = controller
    setBusy(true)
    if (which === 'both') {
      setLlmJson(null)
      setLlm(idleRun)
    }
    try {
      if (which !== 'llm') await runDecision(controller.signal)
      // the decision may have loaded the model: judge the LLM run against the fresh list
      const cold = which === 'both' ? isCold(await refresh()) : isCold()
      if (which !== 'dec' && !controller.signal.aborted) await runLlm(controller.signal, cold)
    } finally {
      setBusy(false)
      refresh()
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        run('both')
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  const requestView = (card: 'dec' | 'llm') => {
    let req = sent[card]
    let note = 'sent with the last run'
    if (!req) {
      if (!schemaObj.value) return `Cannot build the request: ${schemaObj.error}`
      try {
        req = card === 'dec' ? decisionRequest() : llmRequest()
      } catch (e) {
        return `Cannot build the request: ${(e as Error).message}`
      }
      note = 'preview from the current inputs, not sent yet'
    }
    return (
      <>
        <span className="meta">{`// ${note}\nPOST ${req.url}\nContent-Type: application/json\n\n`}</span>
        {JSON.stringify(req.body, null, 2)}
      </>
    )
  }

  const decision = decResult?.decision || null
  const names = decision ? Object.keys(decision) : llmJson ? Object.keys(llmJson) : []
  let same = 0
  let compared = 0
  const cells = names.map((name) => {
    const d = decision?.[name]
    const l = llmJson?.[name]
    const both = !!decision && !!llmJson
    const ok = both && JSON.stringify(d) === JSON.stringify(l)
    if (both) {
      compared++
      if (ok) same++
    }
    const prob = decResult?.fields[name]?.probability
    return (
      <div key={name} className={`fc${both ? (ok ? ' same' : ' diff') : ''}`}>
        <div className="n" title={name}>
          {name}
        </div>
        {decision && (
          <div className="v d">
            <i className="dot d" />
            <span>{d === undefined ? '—' : JSON.stringify(d)}</span>
            {prob != null && <span className="p">{(prob * 100).toFixed(prob > 0.995 ? 0 : 1)}%</span>}
          </div>
        )}
        {llmJson && (
          <div className="v l">
            <i className="dot l" />
            <span>{l === undefined ? '—' : JSON.stringify(l)}</span>
          </div>
        )}
      </div>
    )
  })
  const summaryText = compared
    ? `${same}/${compared} agree` +
      (dec.server && llm.server ? ` · server: decision ${Math.round(dec.server)} ms vs LLM ${Math.round(llm.server)} ms (${(llm.server / dec.server).toFixed(1)}×)` : '') +
      (dec.roundTrip && llm.roundTrip ? ` · round trip ${Math.round(dec.roundTrip)} vs ${Math.round(llm.roundTrip)} ms` : '')
    : ''

  const t = decResult?.timings
  const u = decResult?.usage
  const tabs = (card: 'dec' | 'llm') => (
    <span className="seg view" role="group" aria-label="View">
      {(['out', 'req'] as const).map((v) => (
        <button key={v} type="button" className={view[card] === v ? 'on' : ''} onClick={() => setView((s) => ({ ...s, [card]: v }))}>
          {v === 'out' ? 'Output' : 'Request'}
        </button>
      ))}
    </span>
  )

  return (
    <div className="page playground">
      <div className="toolbar">
        <span className="ctl">
          <label htmlFor="preset">Preset</label>
          <select id="preset" value={inputs.preset} onChange={(e) => e.target.value !== 'custom' && setInputs(presetInputs(e.target.value))}>
            <option value="custom">Custom</option>
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </span>
        <span className="blurb">{blurb}</span>
        <ModelSelect models={models} value={model} onChange={setModel} onRefresh={refresh} />
      </div>
      {modelError && <div className="banner">{modelError}</div>}

      <div className="layout" style={left.style}>
        <section className="card inputs" aria-label="Request">
          <div className="box i">
            <div className="lbl">
              Instructions <small>system prompt for both</small>
            </div>
            <textarea spellCheck={false} value={inputs.instructions} onChange={(e) => update({ instructions: e.target.value })} aria-label="Instructions" />
          </div>
          <SchemaEditor value={inputs.schema} onChange={(schema) => update({ schema })} />
          <div className="box c">
            <div className="lbl">
              Context <small>user message</small>
            </div>
            <textarea spellCheck={false} value={inputs.context} onChange={(e) => update({ context: e.target.value })} aria-label="Context" />
          </div>
          <div className="opts">
            <label className="ctl">
              Mode
              <select value={opts.mode} onChange={(e) => setOpts({ ...opts, mode: e.target.value })}>
                <option>auto</option>
                <option>tree</option>
                <option>greedy</option>
              </select>
            </label>
            <label className="ctl">
              <input type="checkbox" checked={opts.cache} onChange={(e) => setOpts({ ...opts, cache: e.target.checked })} />
              prompt cache
            </label>
            <label className="ctl">
              LLM max
              <input type="number" min={16} max={8192} value={opts.maxTokens} onChange={(e) => setOpts({ ...opts, maxTokens: Number(e.target.value) })} />
            </label>
            <label className="ctl">
              temp
              <input type="number" min={0} max={2} step={0.1} value={opts.temperature} style={{ width: 56 }} onChange={(e) => setOpts({ ...opts, temperature: Number(e.target.value) })} />
            </label>
            <label className="ctl">
              <input type="checkbox" checked={opts.grammar} onChange={(e) => setOpts({ ...opts, grammar: e.target.checked })} />
              grammar
            </label>
            <label className="ctl">
              <input type="checkbox" checked={opts.thinking} onChange={(e) => setOpts({ ...opts, thinking: e.target.checked })} />
              thinking
            </label>
          </div>
          <div className="runs">
            <button type="button" className="primary" disabled={busy || !model} onClick={() => run('dec')}>
              Decision
            </button>
            <button type="button" className="llmbtn" disabled={busy || !model} onClick={() => run('llm')}>
              LLM
            </button>
            <button type="button" disabled={busy || !model} onClick={() => run('both')} title="Cmd/Ctrl+Enter. Runs one after the other so they don't share the GPU.">
              Both ⌘↵
            </button>
            <button type="button" disabled={!busy} onClick={() => abort.current?.abort()}>
              Stop
            </button>
          </div>
        </section>
        {left.gutter}

        <section className="results" style={top.style} aria-label="Results">
          <div className="runners" style={cards.style}>
            <article className="card run dec">
              <div className="rhead">
                <b>/v1/decision</b>
                <span className={`state${dec.running ? ' on' : ''}`}>{dec.status}</span>
                {tabs('dec')}
                <Stopwatch ref={decTimer} className="timer" />
              </div>
              <div className="stats">
                <span><b>{n(t?.prefill_ms, 1)}</b>prefill ms</span>
                <span><b>{n(t?.scoring_ms, 1)}</b>scoring ms</span>
                <span><b>{n(dec.roundTrip)}</b>round trip ms</span>
                <span><b>{n(u?.prompt_tokens)}</b>prompt tok</span>
                <span><b>{n(u?.cached_tokens)}</b>cached</span>
                <span><b>{n(u?.scored_rows)}</b>rows</span>
              </div>
              {view.dec === 'out' ? (
                <pre aria-live="polite">{dec.error ? `Error: ${dec.error}` : decision ? JSON.stringify(decision, null, 2) : ''}</pre>
              ) : (
                <pre className="req">{requestView('dec')}</pre>
              )}
            </article>
            {cards.gutter}
            <article className="card run llm">
              <div className="rhead">
                <b>/v1/chat/completions</b>
                <span className={`state${llm.running ? ' on' : ''}`}>{llm.status}</span>
                {tabs('llm')}
                <Stopwatch ref={llmTimer} className="timer" />
              </div>
              <div className="stats">
                <span><b>{n(llmStats.ttft)}</b>1st tok ms</span>
                <span><b>{n(llmStats.timings?.prompt_ms, 1)}</b>prefill ms</span>
                <span><b>{n(llmStats.timings?.predicted_ms, 1)}</b>gen ms</span>
                <span><b>{llmStats.tokens || '–'}</b>tokens</span>
                <span><b>{n(llmStats.timings?.predicted_per_second, 1)}</b>tok/s</span>
                <span><b>{n(llmStats.promptTokens)}</b>prompt tok</span>
              </div>
              {view.llm === 'out' ? (
                <pre ref={llmOut}>
                  {llmText.reasoning && <span className="think">{llmText.reasoning}</span>}
                  {llmText.content}
                  {llm.running && <span className="caret" />}
                  {llm.error && `\nError: ${llm.error}`}
                </pre>
              ) : (
                <pre className="req">{requestView('llm')}</pre>
              )}
            </article>
          </div>
          {top.gutter}
          <article className="card fields" aria-label="Fields">
            <div className="fhead">
              <b>Fields</b>
              <span className="key"><i className="dot d" />decision (probability)</span>
              <span className="key"><i className="dot l" />LLM</span>
              <span className="sum">{summaryText}</span>
            </div>
            <div className="grid">{cells.length ? cells : <div className="empty">Run a request to see each field here.</div>}</div>
            {decResult && (
              <details>
                <summary>Raw decision response</summary>
                <pre>{JSON.stringify(decResult, null, 2)}</pre>
              </details>
            )}
          </article>
        </section>
      </div>
    </div>
  )
}
