import { useEffect, useRef, useState } from 'react'
import { parseForm, serializeForm, summary, TYPES, type FieldType, type FormField, type FormSchema } from '../lib/schema'

// Two views of one JSON text: a collapsible field form and the raw JSON. The text stays the source
// of truth; the form keeps its own field list while you type (an empty name must not delete a field)
// and writes the JSON back on every edit.
const MODE_KEY = 'decision-playground.schema-editor'

export function SchemaEditor({ value, onChange }: { value: string; onChange: (json: string) => void }) {
  const [mode, setMode] = useState<'form' | 'json'>(() => {
    try {
      return localStorage.getItem(MODE_KEY) === 'json' ? 'json' : 'form'
    } catch {
      return 'form'
    }
  })
  const [form, setForm] = useState<FormSchema | null>(null)
  const [parseError, setParseError] = useState('')
  const [open, setOpen] = useState<Set<number>>(new Set())
  const emitted = useRef<string | null>(null)

  // Re-read the form only when the text changed from outside (a preset, the JSON view).
  useEffect(() => {
    if (value === emitted.current) return
    try {
      setForm(parseForm(JSON.parse(value || '{}')))
      setParseError('')
      setOpen(new Set())
    } catch (e) {
      setParseError((e as Error).message)
    }
  }, [value])

  const switchMode = (m: 'form' | 'json') => {
    setMode(m)
    try {
      localStorage.setItem(MODE_KEY, m)
    } catch {
      /* not remembered */
    }
  }

  const commit = (next: FormSchema) => {
    setForm(next)
    const text = JSON.stringify(serializeForm(next), null, 2)
    emitted.current = text
    onChange(text)
  }
  const edit = (i: number, patch: Partial<FormField>) => {
    if (!form) return
    const fields = form.fields.map((f, k) => (k === i ? { ...f, ...patch } : f))
    commit({ ...form, fields })
  }
  const move = (i: number, d: number) => {
    if (!form) return
    const fields = [...form.fields]
    ;[fields[i], fields[i + d]] = [fields[i + d], fields[i]]
    setOpen(new Set([...open].map((k) => (k === i ? i + d : k === i + d ? i : k))))
    commit({ ...form, fields })
  }
  const remove = (i: number) => {
    if (!form) return
    setOpen(new Set([...open].filter((k) => k !== i).map((k) => (k > i ? k - 1 : k))))
    commit({ ...form, fields: form.fields.filter((_, k) => k !== i) })
  }
  const add = () => {
    if (!form) return
    let n = form.fields.length + 1
    while (form.fields.some((f) => f.name === `field_${n}`)) n++
    setOpen(new Set([...open, form.fields.length]))
    commit({ ...form, fields: [...form.fields, { name: `field_${n}`, type: 'enum', description: '', choices: ['yes', 'no'], extra: {} }] })
  }
  const toggle = (i: number) => {
    const next = new Set(open)
    next.has(i) ? next.delete(i) : next.add(i)
    setOpen(next)
  }

  const showForm = mode === 'form' && !parseError && form
  return (
    <div className="box s">
      <div className="lbl">
        Schema
        <span className="seg" role="group" aria-label="Schema editor mode">
          <button type="button" className={mode === 'form' ? 'on' : ''} onClick={() => switchMode('form')}>
            Form
          </button>
          <button type="button" className={mode === 'json' ? 'on' : ''} onClick={() => switchMode('json')}>
            JSON
          </button>
        </span>
        <small>{form ? `${form.fields.length} fields · ${form.format === 'jsonschema' ? 'JSON Schema' : 'compact'}` : ''}</small>
      </div>
      {showForm ? (
        <div className="sform">
          {form.fields.map((f, i) => (
            <FieldRow
              key={i}
              field={f}
              index={i}
              count={form.fields.length}
              open={open.has(i)}
              onToggle={() => toggle(i)}
              onEdit={(patch) => edit(i, patch)}
              onMove={(d) => move(i, d)}
              onRemove={() => remove(i)}
            />
          ))}
          <button type="button" className="addf" onClick={add}>
            + Add field
          </button>
        </div>
      ) : (
        <textarea
          spellCheck={false}
          value={value}
          aria-label="Schema JSON"
          onChange={(e) => {
            emitted.current = null
            onChange(e.target.value)
          }}
        />
      )}
      {parseError && <div className="err">{mode === 'form' ? 'Fix the JSON to use the form: ' : 'Not valid JSON: '}{parseError}</div>}
    </div>
  )
}

function FieldRow({
  field: f,
  index: i,
  count,
  open,
  onToggle,
  onEdit,
  onMove,
  onRemove,
}: {
  field: FormField
  index: number
  count: number
  open: boolean
  onToggle: () => void
  onEdit: (patch: Partial<FormField>) => void
  onMove: (d: number) => void
  onRemove: () => void
}) {
  const sum = summary(f)
  const id = (k: string) => `sf-${i}-${k}`
  const act = (label: string, title: string, fn: () => void, disabled = false) => (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        fn()
      }}
    >
      {label}
    </button>
  )
  const setType = (type: FieldType) => {
    const patch: Partial<FormField> = { type }
    if (type === 'integer') Object.assign(patch, { minimum: f.minimum ?? 0, maximum: f.maximum ?? 10 })
    if (type === 'number') Object.assign(patch, { minimum: f.minimum ?? 0, maximum: f.maximum ?? 1, step: f.step ?? 0.1 })
    onEdit(patch)
  }
  const num = (key: 'minimum' | 'maximum' | 'step', label: string) => (
    <label>
      {label}{' '}
      <input
        type="number"
        step="any"
        value={f[key] ?? ''}
        onChange={(e) => onEdit({ [key]: e.target.value === '' ? undefined : Number(e.target.value) })}
      />
    </label>
  )
  return (
    <div className={`sf${open ? ' open' : ''}`}>
      <div
        className="sf-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          }
        }}
      >
        <span className="sf-tw" aria-hidden="true">
          ▶
        </span>
        <span className="sf-name">{f.name || '(unnamed)'}</span>
        <span className="sf-type">{f.type}</span>
        <span className={`sf-sum${sum.bad ? ' bad' : ''}`}>{sum.text}</span>
        <span className="sf-act">
          {act('↑', 'Move up', () => onMove(-1), i === 0)}
          {act('↓', 'Move down', () => onMove(1), i === count - 1)}
          {act('✕', `Remove ${f.name}`, onRemove)}
        </span>
      </div>
      {open && (
        <div className="sf-body">
          <label htmlFor={id('name')}>Name</label>
          <input id={id('name')} className="nm" spellCheck={false} value={f.name} onChange={(e) => onEdit({ name: e.target.value.trim() })} />
          <label htmlFor={id('type')}>Type</label>
          <select id={id('type')} value={f.type} onChange={(e) => setType(e.target.value as FieldType)}>
            {TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          {f.type === 'enum' ? (
            <>
              <label htmlFor={id('values')}>Allowed values</label>
              <Chips id={id('values')} values={f.choices} onChange={(choices) => onEdit({ choices })} />
            </>
          ) : f.type === 'boolean' ? (
            <>
              <label>Values</label>
              <span className="nums">true or false</span>
            </>
          ) : (
            <>
              <label>Range</label>
              <span className="nums">
                {num('minimum', 'min')}
                {num('maximum', 'max')}
                {f.type === 'number' && num('step', 'step')}
              </span>
            </>
          )}
          <label htmlFor={id('desc')}>Description</label>
          <textarea
            id={id('desc')}
            rows={2}
            value={f.description}
            placeholder="What this field means and how to choose it"
            onChange={(e) => onEdit({ description: e.target.value })}
          />
        </div>
      )}
    </div>
  )
}

// Enter or a comma adds a chip; pasting "a, b, c" adds three; Backspace in the empty box removes the last.
function Chips({ id, values, onChange }: { id: string; values: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const add = (raw: string) => {
    const fresh = raw
      .split(',')
      .map((x) => x.trim())
      .filter((x, k, all) => x && !values.includes(x) && all.indexOf(x) === k)
    if (fresh.length) onChange([...values, ...fresh])
  }
  return (
    <div className="chips" onClick={() => input.current?.focus()}>
      {values.map((c, k) => (
        <span key={c} className="chip">
          <span title={c}>{c}</span>
          <button
            type="button"
            aria-label={`Remove ${c}`}
            onClick={(e) => {
              e.stopPropagation()
              onChange(values.filter((_, j) => j !== k))
              input.current?.focus()
            }}
          >
            ×
          </button>
        </span>
      ))}
      <input
        id={id}
        ref={input}
        spellCheck={false}
        value={text}
        placeholder={values.length ? 'add value' : 'type a value, Enter to add'}
        onChange={(e) => {
          const v = e.target.value
          if (v.includes(',')) {
            const parts = v.split(',')
            setText(parts.pop() || '')
            add(parts.join(','))
          } else setText(v)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            add(text)
            setText('')
          } else if (e.key === 'Backspace' && !text && values.length) onChange(values.slice(0, -1))
        }}
        onBlur={() => {
          if (text.trim()) {
            add(text)
            setText('')
          }
        }}
      />
    </div>
  )
}
