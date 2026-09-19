// Game loop: fixed 120 Hz physics on animation frames, and a decision loop that asks llama-server's
// /v1/decision for each agent's controls at the chosen rate. The simulation keeps running while a
// request is in flight; controls apply when the answer arrives.
import { applyControls, createGame, idle, update, validateControls } from './sim.js'
import { aimDeviation, buildLayaContext, LAYA_SCHEMA } from './aim-context.js'
import { mojoContext } from './compact.js'
import { decide, type ApiRequest, type DecisionResponse } from '../lib/api'

// Field rules point at the aim fields the model is given, matching the instructions below.
// Combat fixtures (36 states, aim info on): turn_dir 18/18, turn_angle 18/18, fire 18/18 on the 35B.
export const GAME_SCHEMA = {
  ...LAYA_SCHEMA,
  turn_dir: {
    ...LAYA_SCHEMA.turn_dir,
    description:
      'Use aim_deviation_direction (left or right); hold only when aim_deviation_degrees is 0. Without aim fields, take the shortest turn toward bearing_degrees: right increases heading.',
  },
  fire: {
    ...LAYA_SCHEMA.fire,
    description:
      'true when aim_deviation_degrees is 10 or less, even while turning; otherwise false. Without aim fields, true when heading is within 10 degrees of bearing_degrees.',
  },
  turn_angle: {
    type: 'integer',
    minimum: 0,
    maximum: 90,
    description: 'aim_deviation_degrees, capped at 90; 0 when aligned. Without aim fields, the smallest angle between heading and bearing_degrees, capped at 90.',
  },
}

export const GAME_INSTRUCTIONS = [
  'Choose controls to defeat the enemy and survive.',
  'fire: true whenever aim_deviation_degrees is 10 or less, even while turning; otherwise false.',
  'turn_dir: aim_deviation_direction; hold only when aim_deviation_degrees is 0.',
  'turn_angle: aim_deviation_degrees, capped at 90.',
  'Without aim fields, turn toward bearing_degrees from your heading.',
  'movement: approach the enemy along a clear direction when far; stay when close.',
  'stance: stand unless a bullet is incoming; jump or crouch to evade it.',
].join('\n')

export type Actor = 'player' | 'enemy'
export type Scenario = 'stationary' | 'duel'

export interface GameConfig {
  server: string
  model: string
  hz: number
  moveSeconds: number | null // null: a movement command holds until the next decision
  aim: boolean
  instructions: string
}

export interface AgentTiming {
  batched: boolean // decided in one request together with the other agent
  roundTrip: number
  server: number
  prefill: number
  scoring: number
  cached: boolean
  sharedTokens: number
  contextTokens: number
}

const PHYSICS_DT = 1 / 120

export class GameRunner {
  game: any
  cfg: GameConfig
  status = 'Paused · ready'
  running = false
  stepping = false
  busy = false
  calls = 0
  accepted = 0
  latency: number | null = null
  // request rate over the current run only (paused time doesn't count)
  private runStart = 0
  private runCalls = 0
  rate: number | null = null
  timings: Partial<Record<Actor, AgentTiming>> = {}
  contexts: Partial<Record<Actor, string>> = {}
  requests: ApiRequest[] = []
  responses: DecisionResponse[] = []
  lastControls: Partial<Record<Actor, Record<string, unknown>>> = {}
  events: string[] = []
  private generation = 0
  private stepRemaining = 0
  private accumulator = 0
  private physicsLast = performance.now()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(cfg: GameConfig, scenario: Scenario = 'stationary') {
    this.cfg = cfg
    this.game = createGame(scenario)
    this.game.moveSeconds = cfg.moveSeconds
  }

  get scenario(): Scenario {
    return this.game.scenario
  }

  setConfig(cfg: GameConfig) {
    this.cfg = cfg
    this.game.moveSeconds = cfg.moveSeconds
  }

  private log(message: string) {
    this.events = [message, ...this.events].slice(0, 40)
  }

  reset(scenario: Scenario = this.scenario) {
    this.stop('Paused · ready')
    this.game = createGame(scenario)
    this.game.moveSeconds = this.cfg.moveSeconds
    this.calls = this.accepted = 0
    this.latency = this.rate = null
    this.timings = {}
    this.contexts = {}
    this.requests = []
    this.responses = []
    this.lastControls = {}
    this.events = []
    this.log('Reset · seed 7')
  }

  stop(message = 'Paused') {
    this.generation++
    this.running = this.stepping = false
    this.stepRemaining = this.accumulator = 0
    this.physicsLast = performance.now()
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    applyControls(this.game, idle(), idle())
    this.status = message
  }

  canStart() {
    return !this.busy && !this.running && !this.stepping && this.game.status === 'playing' && !!this.cfg.model
  }

  start() {
    if (!this.canStart()) return
    this.generation++
    this.running = true
    this.accumulator = 0
    this.physicsLast = performance.now()
    this.runStart = performance.now()
    this.runCalls = this.calls
    this.cycle(this.generation, false)
  }

  // One decision, then exactly 1/Hz seconds of physics with those controls.
  step() {
    if (!this.canStart()) return
    this.generation++
    this.stepping = true
    this.stepRemaining = 0
    this.accumulator = 0
    this.physicsLast = performance.now()
    this.cycle(this.generation, true)
  }

  private observe(snapshot: unknown, dt: number, actor: Actor): { instructions: string; context: string } {
    const text =
      buildLayaContext(snapshot, dt, actor, { instructions: this.cfg.instructions, previous: null }) +
      (this.cfg.aim ? '\nRelative enemy aim deviation: ' + JSON.stringify(aimDeviation(snapshot, actor)) : '')
    const { static_context, context } = mojoContext(text, true)
    return { instructions: static_context, context }
  }

  private request(instructions: string, contexts: string[]): ApiRequest {
    return {
      url: `${this.cfg.server}/v1/decision`,
      body: { model: this.cfg.model, instructions, contexts, schema: GAME_SCHEMA, cache_prompt: true },
    }
  }

  private async cycle(token: number, once: boolean) {
    if (this.busy || token !== this.generation || (!once && !this.running)) return
    const dt = 1 / this.cfg.hz
    this.busy = true
    const started = performance.now()
    const duel = this.scenario === 'duel'
    const actors: Actor[] = duel ? ['player', 'enemy'] : ['player']
    // Both agents decide from the same frozen snapshot.
    const snapshot = JSON.parse(JSON.stringify(this.game))
    const controls: Partial<Record<Actor, ReturnType<typeof validateControls>>> = {}
    let delay = 0
    try {
      const seen = actors.map((a) => this.observe(snapshot, dt, a))
      actors.forEach((a, k) => (this.contexts[a] = seen[k].context))
      // Agents with the same fixed prompt decide in one request, one context each.
      const groups = seen.every((o) => o.instructions === seen[0].instructions) ? [actors] : actors.map((a) => [a])
      this.requests = []
      this.responses = []
      for (const group of groups) {
        if (token !== this.generation) return
        this.status = `Requesting ${group.map((a) => (a === 'player' ? 'cyan' : 'red')).join(' + ')} controls…`
        const req = this.request(seen[actors.indexOf(group[0])].instructions, group.map((a) => this.contexts[a]!))
        this.requests.push(req)
        this.calls++
        const t0 = performance.now()
        const data = await decide(req)
        if (token !== this.generation) return
        this.responses.push(data)
        group.forEach((actor, k) => {
          const item = data.results[k]
          this.timings[actor] = {
            batched: group.length > 1,
            roundTrip: performance.now() - t0,
            server: data.timings.total_ms,
            prefill: data.timings.prefill_ms,
            scoring: data.timings.scoring_ms,
            cached: data.usage.cached_tokens > 0,
            sharedTokens: data.usage.prompt_tokens - data.usage.context_tokens,
            contextTokens: item.usage.context_tokens,
          }
          controls[actor] = validateControls({ ...item.decision, turn_angle: Number(item.decision.turn_angle) })
        })
      }
      if (token !== this.generation) return
      this.latency = performance.now() - started
      if (this.running) this.rate = (this.calls - this.runCalls) / ((performance.now() - this.runStart) / 1000)
      applyControls(this.game, controls.player, controls.enemy)
      this.accepted++
      this.lastControls = { ...controls }
      if (once) {
        this.stepRemaining = dt
        this.accumulator = 0
        this.physicsLast = performance.now()
      }
      this.log(`#${this.accepted} · sim ${this.game.time.toFixed(2)}s · ${this.latency.toFixed(0)} ms · ${actors.map((a) => JSON.stringify(controls[a])).join(' | ')}`)
      this.status = once ? 'Step · playing one decision' : 'Running'
      delay = Math.max(0, dt * 1000 - (performance.now() - started))
      if (this.game.status !== 'playing') this.running = false
    } catch (e) {
      if (token === this.generation) {
        this.stop(`Paused · ${(e as Error).message}`)
        this.log(`Error · ${(e as Error).message}`)
      }
    } finally {
      this.busy = false
      if (token === this.generation && this.running && this.game.status === 'playing') {
        this.timer = setTimeout(() => this.cycle(token, false), delay)
      }
    }
  }

  private outcome() {
    const g = this.game
    if (g.scenario === 'duel') return g.status === 'draw' ? 'Draw · both defeated' : g.status === 'won' ? 'Cyan won' : 'Red won'
    return g.status === 'won' ? 'Won · target defeated' : 'Lost · player defeated'
  }

  // Called every animation frame: advances physics in fixed steps while running or stepping.
  advance(now: number) {
    const elapsed = Math.min(0.1, Math.max(0, (now - this.physicsLast) / 1000))
    this.physicsLast = now
    if (!this.running && this.stepRemaining <= 0) {
      this.accumulator = 0
      return
    }
    this.accumulator += elapsed
    while (this.running || this.stepRemaining > 0) {
      // A shortened final substep gives an exact 1/Hz duration for Step.
      const dt = this.running ? PHYSICS_DT : Math.min(PHYSICS_DT, this.stepRemaining)
      if (this.accumulator + 1e-12 < dt) break
      const before = new Set(this.game.events)
      update(this.game, dt)
      this.accumulator = Math.max(0, this.accumulator - dt)
      for (const e of this.game.events.filter((x: unknown) => !before.has(x))) this.log(`${e.time.toFixed(2)}s · ${e.message}`)
      if (this.game.status !== 'playing') {
        this.stop(this.outcome())
        break
      }
      if (!this.running) {
        this.stepRemaining = Math.max(0, this.stepRemaining - dt)
        if (this.stepRemaining < 1e-10) {
          this.stop('Paused · step complete')
          break
        }
      }
    }
  }
}
