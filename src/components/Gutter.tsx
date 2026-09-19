import { useState, type CSSProperties } from 'react'

// Draggable divider inside a CSS grid. The size is a percentage of the parent's width (axis x)
// or pixels of its height (axis y), exposed as a CSS variable and remembered per browser.
interface SplitSpec {
  key: string
  axis: 'x' | 'y'
  min: number
  max: number | ((parent: HTMLElement) => number)
  step: number
}

function read(key: string): number | null {
  try {
    const v = localStorage.getItem(`decision-playground.split.${key}`)
    return v == null ? null : Number(v)
  } catch {
    return null
  }
}

function save(key: string, v: number | null) {
  try {
    const k = `decision-playground.split.${key}`
    v == null ? localStorage.removeItem(k) : localStorage.setItem(k, String(v))
  } catch {
    /* not remembered */
  }
}

export function useSplit(spec: SplitSpec, cssVar: string) {
  const [size, setSize] = useState<number | null>(() => read(spec.key))
  const style = (size == null ? {} : { [cssVar]: size + (spec.axis === 'x' ? '%' : 'px') }) as CSSProperties
  const gutter = <Gutter spec={spec} size={size} setSize={setSize} />
  return { style, gutter }
}

function Gutter({ spec, size, setSize }: { spec: SplitSpec; size: number | null; setSize: (v: number | null) => void }) {
  const [drag, setDrag] = useState(false)
  const limit = (parent: HTMLElement, v: number) =>
    Math.min(typeof spec.max === 'function' ? spec.max(parent) : spec.max, Math.max(spec.min, v))
  const at = (el: HTMLElement, e: React.PointerEvent) => {
    const r = el.parentElement!.getBoundingClientRect()
    return spec.axis === 'x' ? ((e.clientX - r.left) / r.width) * 100 : e.clientY - r.top
  }
  const current = (el: HTMLElement) => {
    if (size != null) return size
    const parent = el.parentElement!.getBoundingClientRect()
    const first = (el.parentElement!.firstElementChild as HTMLElement).getBoundingClientRect()
    return spec.axis === 'x' ? (first.width / parent.width) * 100 : first.height
  }
  return (
    <div
      className={`gutter ${spec.axis === 'x' ? 'v' : 'h'}${drag ? ' drag' : ''}`}
      role="separator"
      aria-orientation={spec.axis === 'x' ? 'vertical' : 'horizontal'}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={(e) => {
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        setDrag(true)
        document.body.classList.add('dragging', spec.axis === 'x' ? 'dx' : 'dy')
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
        setSize(Math.round(limit(e.currentTarget.parentElement!, at(e.currentTarget, e)) * 10) / 10)
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId)
        setDrag(false)
        document.body.classList.remove('dragging', 'dx', 'dy')
        save(spec.key, size)
      }}
      onDoubleClick={() => {
        setSize(null)
        save(spec.key, null)
      }}
      onKeyDown={(e) => {
        const d = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key]
        if (!d) return
        e.preventDefault()
        const v = limit(e.currentTarget.parentElement!, current(e.currentTarget) + d * spec.step)
        setSize(v)
        save(spec.key, v)
      }}
    />
  )
}
