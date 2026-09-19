import { useEffect, useRef, useState } from 'react'
import { useSettings } from '../lib/settings'
import { ModelSelect, useModelChoice, useModels } from '../components/ModelSelect'
import { useSplit } from '../components/Gutter'
import { GAME_INSTRUCTIONS, GAME_SCHEMA, GameRunner, type Actor, type Scenario } from '../game/runner'
import { COMPACT_COLUMNS } from '../game/compact.js'

const MOVE_WINDOWS = [
  { value: '0.15', label: '0.15 s' },
  { value: '0.3', label: '0.3 s' },
  { value: '0.5', label: '0.5 s' },
  { value: '1', label: '1 s' },
  { value: 'hold', label: 'hold until next' },
]
const SMOOTHING_MS = 60
const COLORS: Record<Actor, string> = { player: '#5ee4ee', enemy: '#ff667a' }
const ms = (v: number | null | undefined, d = 0) => (v == null ? '—' : `${v.toFixed(d)} ms`)

export function Game() {
  const { server } = useSettings()
  const { models, error: modelError, refresh } = useModels()
  const [model, setModel] = useModelChoice('game', models)
  const [scenario, setScenario] = useState<Scenario>('stationary')
  const [hz, setHz] = useState(4)
  const [moveWindow, setMoveWindow] = useState('0.3')
  const [aim, setAim] = useState(true)
  const [instructions, setInstructions] = useState(GAME_INSTRUCTIONS)
  const [panel, setPanel] = useState<'request' | 'response' | 'log'>('request')
  const [, setTick] = useState(0)

  const cfg = { server, model, hz, moveSeconds: moveWindow === 'hold' ? null : Number(moveWindow), aim, instructions }
  const runner = useRef<GameRunner | null>(null)
  if (!runner.current) runner.current = new GameRunner(cfg, scenario)
  const r = runner.current
  r.setConfig(cfg)

  const canvas = useRef<HTMLCanvasElement>(null)
  const side = useSplit({ key: 'game-side', axis: 'x', min: 35, max: 80, step: 2 }, '--arena')

  // Physics and drawing on every frame; React only re-renders the panels a few times a second.
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    const visuals = new WeakMap<object, { x: number; y: number; yaw: number }>()
    const shortestArc = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180
    const visual = (obj: { x: number; y: number; yaw?: number }, alpha: number) => {
      let v = visuals.get(obj)
      if (!v) {
        v = { x: obj.x, y: obj.y, yaw: obj.yaw ?? 0 }
        visuals.set(obj, v)
      }
      v.x += (obj.x - v.x) * alpha
      v.y += (obj.y - v.y) * alpha
      if (obj.yaw != null) v.yaw = shortestArc(v.yaw + shortestArc(obj.yaw - v.yaw) * alpha)
      return v
    }
    const frame = (now: number) => {
      const g = runner.current!
      g.advance(now)
      const alpha = -Math.expm1(-Math.max(0, now - last) / SMOOTHING_MS)
      last = now
      const ctx = canvas.current?.getContext('2d')
      if (ctx) {
        const s = g.game
        ctx.clearRect(0, 0, 800, 500)
        ctx.strokeStyle = '#172536'
        ctx.lineWidth = 1
        for (let x = 0; x <= 800; x += 50) {
          ctx.beginPath()
          ctx.moveTo(x, 0)
          ctx.lineTo(x, 500)
          ctx.stroke()
        }
        for (let y = 0; y <= 500; y += 50) {
          ctx.beginPath()
          ctx.moveTo(0, y)
          ctx.lineTo(800, y)
          ctx.stroke()
        }
        for (const o of s.obstacles) {
          ctx.fillStyle = '#34465b'
          ctx.fillRect(o.x, o.y, o.w, o.h)
          ctx.strokeStyle = '#61738a'
          ctx.strokeRect(o.x, o.y, o.w, o.h)
        }
        const agents: [Actor, string][] = [
          ['player', 'CYAN'],
          ['enemy', s.scenario === 'duel' ? 'RED' : 'TARGET'],
        ]
        for (const [actor, name] of agents) {
          const a = s[actor]
          const v = visual(a, alpha)
          const color = COLORS[actor]
          ctx.globalAlpha = a.hp > 0 ? 1 : 0.3
          ctx.fillStyle = color
          ctx.beginPath()
          ctx.arc(v.x, v.y, a.r, 0, Math.PI * 2)
          ctx.fill()
          const angle = (v.yaw * Math.PI) / 180
          const reach = actor === 'player' || s.scenario === 'duel' ? 90 : 25
          ctx.strokeStyle = color
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.moveTo(v.x, v.y)
          ctx.lineTo(v.x + Math.cos(angle) * reach, v.y + Math.sin(angle) * reach)
          ctx.stroke()
          if (a.jump > 0) {
            ctx.beginPath()
            ctx.arc(v.x, v.y, 22, 0, Math.PI * 2)
            ctx.stroke()
          }
          ctx.fillStyle = '#273448'
          ctx.fillRect(v.x - 25, v.y - 32, 50, 5)
          ctx.fillStyle = color
          ctx.fillRect(v.x - 25, v.y - 32, a.hp / 2, 5)
          ctx.font = '11px ui-monospace, monospace'
          ctx.fillText(name, v.x - 20, v.y - 40)
          ctx.globalAlpha = 1
        }
        for (const b of s.bullets) {
          const v = visual(b, alpha)
          ctx.fillStyle = b.owner === 'player' ? '#b4fbff' : '#ff9a81'
          ctx.beginPath()
          ctx.arc(v.x, v.y, 3, 0, Math.PI * 2)
          ctx.fill()
        }
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    const panels = setInterval(() => setTick((t) => t + 1), 200)
    const onHide = () => document.hidden && runner.current!.stop('Paused · tab hidden')
    document.addEventListener('visibilitychange', onHide)
    return () => {
      cancelAnimationFrame(raf)
      clearInterval(panels)
      document.removeEventListener('visibilitychange', onHide)
      runner.current!.stop()
    }
  }, [])

  const g = r.game
  const duel = r.scenario === 'duel'
  const actors: Actor[] = duel ? ['player', 'enemy'] : ['player']
  const locked = r.running || r.stepping || r.busy

  const contextRows = (actor: Actor) => {
    const text = (r.requests[actor]?.body.context as string) || ''
    if (!text) return null
    return (
      <table className="cols">
        <tbody>
          {text.split('\n').map((line) => {
            const i = line.indexOf(':')
            const name = line.slice(0, i)
            const values = line.slice(i + 1)
            const cols = (COMPACT_COLUMNS as Record<string, string[]>)[name]
            const parts = values === 'none' ? ['none'] : values.split(',')
            return (
              <tr key={name}>
                <th>{name}</th>
                <td>
                  {parts.map((v, k) => (
                    <span className="chip" key={k}>
                      {cols && parts.length === cols.length && <span className="k">{cols[k].replace(/_/g, ' ')}</span>}
                      <span>{v}</span>
                    </span>
                  ))}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    )
  }

  return (
    <div className="page game">
      <div className="toolbar">
        <ModelSelect models={models} value={model} onChange={setModel} onRefresh={refresh} />
        <label className="ctl">
          Scenario
          <select
            value={scenario}
            onChange={(e) => {
              const s = e.target.value as Scenario
              setScenario(s)
              r.reset(s)
            }}
          >
            <option value="stationary">Moving target</option>
            <option value="duel">Duel · both agents</option>
          </select>
        </label>
        <label className="ctl">
          Decisions
          <select value={hz} disabled={locked} onChange={(e) => setHz(Number(e.target.value))}>
            {[1, 2, 3, 4, 5, 6, 8, 10].map((v) => (
              <option key={v} value={v}>
                {v} / s
              </option>
            ))}
          </select>
        </label>
        <label className="ctl">
          Move for
          <select value={moveWindow} onChange={(e) => setMoveWindow(e.target.value)}>
            {MOVE_WINDOWS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="ctl">
          <input type="checkbox" checked={aim} onChange={(e) => setAim(e.target.checked)} />
          aim info
        </label>
        <span className="runs">
          <button type="button" className="primary" disabled={!r.canStart()} onClick={() => r.start()}>
            Start
          </button>
          <button type="button" disabled={!r.canStart()} onClick={() => r.step()} title="One decision, then 1/rate seconds of play">
            Step
          </button>
          <button type="button" disabled={!r.running && !r.stepping && !r.busy} onClick={() => r.stop('Paused')}>
            Pause
          </button>
          <button type="button" onClick={() => r.reset(scenario)}>
            Reset
          </button>
        </span>
      </div>
      {modelError && <div className="banner">{modelError}</div>}

      <div className="game-layout" style={side.style}>
        <section className="card arena-card">
          <div className="rhead">
            <b>Arena</b>
            <span className={`state${r.running ? ' on' : ''}`}>{r.status}</span>
            <span className="timer">
              {r.timings.player ? r.timings.player.server.toFixed(0) : '–'}
              <small>ms server</small>
            </span>
          </div>
          <div className="canvas-wrap">
            <canvas ref={canvas} width={800} height={500} aria-label="Top-down arena: cyan agent, red target, gray cover" />
          </div>
          <div className="stats">
            <span><b>{g.time.toFixed(1)}</b>s sim</span>
            <span><b>{r.accepted}</b>decisions</span>
            <span><b>{g.player.hp}</b>cyan HP</span>
            <span><b>{g.enemy.hp}</b>{duel ? 'red' : 'target'} HP</span>
            <span><b>{g.shots}/{g.hits}</b>shots/hits</span>
            {duel && <span><b>{g.enemyShots}/{g.enemyHits}</b>red shots/hits</span>}
          </div>
        </section>
        {side.gutter}
        <section className="side">
          <article className="card tele">
            <div className="rhead">
              <b>Telemetry</b>
            </div>
            <dl>
              <dt>{duel ? 'Pair round trip' : 'Round trip'}</dt>
              <dd>{ms(r.latency, 1)}</dd>
              {actors.map((a) => (
                <div className="tgroup" key={a} style={{ borderColor: COLORS[a] }}>
                  <dt>{a === 'player' ? 'Cyan' : 'Red'} server / prefill / scoring</dt>
                  <dd>
                    {ms(r.timings[a]?.server, 1)} / {ms(r.timings[a]?.prefill)} / {ms(r.timings[a]?.scoring)}
                  </dd>
                  <dt>Fixed prompt cache · tokens fixed / changing</dt>
                  <dd>
                    {r.timings[a] ? (r.timings[a]!.cached ? 'hit' : 'miss') : '—'} · {r.timings[a]?.sharedTokens ?? '—'} / {r.timings[a]?.contextTokens ?? '—'}
                  </dd>
                </div>
              ))}
              <dt>Requests / accepted</dt>
              <dd>
                {r.calls} / {r.accepted}
              </dd>
              <dt>Requests per second (this run)</dt>
              <dd>{r.rate == null ? '—' : r.rate.toFixed(2)}</dd>
              <dt>Movement</dt>
              <dd>{cfg.moveSeconds == null ? 'held until the next decision' : `${Math.round(cfg.moveSeconds * 1000)} ms per decision`}</dd>
            </dl>
            <div className="controls-now">
              {actors.map((a) => (
                <div key={a}>
                  <i className="dot" style={{ background: COLORS[a] }} />
                  {r.lastControls[a] ? Object.entries(r.lastControls[a]!).map(([k, v]) => `${k} ${String(v)}`).join(' · ') : 'no decision yet'}
                </div>
              ))}
            </div>
          </article>

          <article className="card detail">
            <div className="rhead">
              <span className="seg view" role="group" aria-label="Detail view">
                {(['request', 'response', 'log'] as const).map((p) => (
                  <button key={p} type="button" className={panel === p ? 'on' : ''} onClick={() => setPanel(p)}>
                    {p === 'request' ? 'Request' : p === 'response' ? 'Response' : 'Events'}
                  </button>
                ))}
              </span>
            </div>
            <div className="detail-body">
              {panel === 'request' &&
                (actors.some((a) => r.requests[a]) ? (
                  actors.map((a) =>
                    r.requests[a] ? (
                      <div key={a} className="req-block">
                        <h4 style={{ color: COLORS[a] }}>{a === 'player' ? 'Cyan' : 'Red'} · changing context, sent every decision</h4>
                        {contextRows(a)}
                        <details>
                          <summary>Full request body · POST {r.requests[a]!.url}</summary>
                          <pre>{JSON.stringify(r.requests[a]!.body, null, 2)}</pre>
                        </details>
                      </div>
                    ) : null,
                  )
                ) : (
                  <p className="empty">Start or Step to send the first request.</p>
                ))}
              {panel === 'response' &&
                (actors.some((a) => r.responses[a]) ? (
                  actors.map((a) => r.responses[a] && <pre key={a}>{JSON.stringify(r.responses[a], null, 2)}</pre>)
                ) : (
                  <p className="empty">No response yet.</p>
                ))}
              {panel === 'log' && (
                <ol className="events">
                  {r.events.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ol>
              )}
            </div>
          </article>

          <article className="card instr">
            <div className="lbl">
              Instructions <small>fixed prompt, cached between decisions</small>
              <button type="button" className="link" onClick={() => setInstructions(GAME_INSTRUCTIONS)} disabled={instructions === GAME_INSTRUCTIONS}>
                reset
              </button>
            </div>
            <textarea spellCheck={false} value={instructions} onChange={(e) => setInstructions(e.target.value)} aria-label="Game instructions" />
            <details>
              <summary>Control schema</summary>
              <pre>{JSON.stringify(GAME_SCHEMA, null, 2)}</pre>
            </details>
          </article>
        </section>
      </div>
    </div>
  )
}
