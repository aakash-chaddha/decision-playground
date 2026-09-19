// Decision schemas come in two shapes: compact fields ({name: {type, choices|minimum..., description}})
// or JSON Schema ({properties: {...}}). The form editor round-trips both, keeping keys it doesn't show.

export const TYPES = ['enum', 'boolean', 'integer', 'number'] as const
export type FieldType = (typeof TYPES)[number]

export interface FormField {
  name: string
  type: FieldType
  description: string
  choices: string[]
  minimum?: number
  maximum?: number
  step?: number
  extra: Record<string, unknown>
}

export interface FormSchema {
  format: 'compact' | 'jsonschema'
  top: Record<string, unknown>
  fields: FormField[]
}

type Json = Record<string, unknown>

export function parseForm(schema: Json): FormSchema {
  const js = !!schema.properties
  const props = (js ? schema.properties : schema) as Record<string, Json>
  const { properties: _ignored, ...top } = js ? schema : ({} as Json)
  const fields = Object.entries(props).map(([name, f]) => {
    const { type, description, enum: en, choices, minimum, maximum, step, multipleOf, ...extra } = f
    const values = (en || choices || []) as string[]
    const kind = en || choices || type === 'enum' ? 'enum' : (type as string)
    return {
      name,
      type: (TYPES as readonly string[]).includes(kind) ? (kind as FieldType) : 'enum',
      description: (description as string) || '',
      choices: values.map(String),
      minimum: minimum as number | undefined,
      maximum: maximum as number | undefined,
      step: (js ? multipleOf : step) as number | undefined,
      extra,
    }
  })
  return { format: js ? 'jsonschema' : 'compact', top, fields }
}

export function serializeForm(form: FormSchema): Json {
  const js = form.format === 'jsonschema'
  const props: Json = {}
  for (const f of form.fields) {
    if (!f.name) continue
    const o: Json = {}
    if (f.type === 'enum') {
      if (!js) o.type = 'enum'
      o[js ? 'enum' : 'choices'] = f.choices
    } else o.type = f.type
    if (f.type === 'integer' || f.type === 'number') {
      o.minimum = f.minimum
      o.maximum = f.maximum
    }
    if (f.type === 'number') o[js ? 'multipleOf' : 'step'] = f.step
    if (f.description) o.description = f.description
    props[f.name] = { ...o, ...f.extra }
  }
  return js ? { ...form.top, type: 'object', properties: props } : props
}

export function valueCount(f: FormField): number {
  if (f.type === 'boolean') return 2
  if (f.type === 'enum') return f.choices.length
  if (f.type === 'integer')
    return Number.isInteger(f.minimum) && Number.isInteger(f.maximum) ? f.maximum! - f.minimum! + 1 : NaN
  const n = (f.maximum! - f.minimum!) / f.step!
  return f.step! > 0 && Number.isFinite(n) && Math.abs(n - Math.round(n)) < 1e-7 ? Math.round(n) + 1 : NaN
}

export function summary(f: FormField): { text: string; bad: boolean } {
  const n = valueCount(f)
  const bad = !(n >= 1 && n <= 255)
  const count = Number.isNaN(n) ? 'bad range' : n > 255 ? `${n} values, max 255` : `${n} values`
  let text: string
  if (f.type === 'boolean') text = 'true · false'
  else if (f.type === 'enum') text = f.choices.length ? f.choices.join(' · ') : 'no values yet'
  else text = `${f.minimum ?? '?'} – ${f.maximum ?? '?'}` + (f.type === 'number' ? ` step ${f.step ?? '?'}` : '') + ` · ${count}`
  return { text, bad }
}

// The same schema as a strict JSON Schema, for the grammar-constrained LLM comparison.
export function toJsonSchema(schema: Json): Json {
  if (schema.properties) {
    return {
      ...schema,
      type: 'object',
      required: schema.required || Object.keys(schema.properties as Json),
      additionalProperties: false,
    }
  }
  const properties: Json = {}
  for (const [name, raw] of Object.entries(schema)) {
    const f = raw as Json
    const p: Json = f.description ? { description: f.description } : {}
    const kind = f.enum ? 'enum' : f.type
    if (kind === 'boolean') p.type = 'boolean'
    else if (kind === 'enum' || kind === 'choice' || kind === 'selection') Object.assign(p, { type: 'string', enum: f.enum || f.choices })
    else if (kind === 'integer') Object.assign(p, { type: 'integer', minimum: f.minimum, maximum: f.maximum })
    else if (kind === 'number') Object.assign(p, { type: 'number', minimum: f.minimum, maximum: f.maximum }, f.step ? { multipleOf: f.step } : {})
    else throw new Error(`field "${name}": unsupported type ${String(f.type)}`)
    properties[name] = p
  }
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false }
}
