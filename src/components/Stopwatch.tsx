import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'

// Live timer that repaints itself on animation frames without re-rendering React.
// After a run the owner can replace the reading with the server's own time.
export interface StopwatchHandle {
  start: () => void
  stop: () => number
  elapsed: () => number
  showServer: (ms: number) => void
}

const format = (ms: number, label = '') =>
  ms < 10000
    ? `${ms.toFixed(ms < 100 && label ? 1 : 0)}<small>ms${label}</small>`
    : `${(ms / 1000).toFixed(2)}<small>s${label}</small>`

export const Stopwatch = forwardRef<StopwatchHandle, { className?: string }>(function Stopwatch({ className }, ref) {
  const el = useRef<HTMLSpanElement>(null)
  const t0 = useRef(0)
  const raf = useRef(0)
  useEffect(() => () => cancelAnimationFrame(raf.current), [])
  useImperativeHandle(ref, () => ({
    start() {
      t0.current = performance.now()
      cancelAnimationFrame(raf.current)
      const tick = () => {
        if (el.current) el.current.innerHTML = format(performance.now() - t0.current)
        raf.current = requestAnimationFrame(tick)
      }
      tick()
    },
    stop() {
      cancelAnimationFrame(raf.current)
      const ms = performance.now() - t0.current
      if (el.current) el.current.innerHTML = format(ms)
      return ms
    },
    elapsed: () => performance.now() - t0.current,
    showServer(ms: number) {
      if (el.current) el.current.innerHTML = format(ms, ' server')
    },
  }))
  return <span ref={el} className={className} dangerouslySetInnerHTML={{ __html: format(0) }} />
})
