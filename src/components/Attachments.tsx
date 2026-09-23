import { useEffect, useRef, useState } from 'react'
import { buildAttachment, fetchModalities, mediaLabel, NO_MODALITIES, type Attachment, type Modalities } from '../lib/multimodal'

// What the selected model can take: /props for a single-model server, /v1/models architecture for a
// router. Re-read whenever the server or the model changes.
export function useModalities(server: string, model: string) {
  const [modalities, setModalities] = useState<Modalities>(NO_MODALITIES)
  useEffect(() => {
    let live = true
    if (!server || !model) {
      setModalities(NO_MODALITIES)
      return
    }
    fetchModalities(server, model).then((m) => live && setModalities(m))
    return () => {
      live = false
    }
  }, [server, model])
  return modalities
}

const accept = (m: Modalities) =>
  [m.vision && 'image/*,.pdf', m.audio && 'audio/*', m.video && 'video/*', '.txt,.md,.json,.csv,.log']
    .filter(Boolean)
    .join(',')

// Hidden entirely for text-only models, which is the whole point: files only make sense when the
// model has a media encoder.
export function Attachments({
  modalities,
  value,
  onChange,
}: {
  modalities: Modalities
  value: Attachment[]
  onChange: (next: Attachment[]) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [reading, setReading] = useState(0)
  const label = mediaLabel(modalities)
  if (!label && !value.length && !reading) return null

  const add = async (files: FileList | null) => {
    if (!files?.length) return
    const picked = [...files]
    setReading((n) => n + picked.length)
    const added = await Promise.all(picked.map((f) => buildAttachment(f, modalities)))
    setReading((n) => n - picked.length)
    onChange([...value, ...added])
    if (input.current) input.current.value = ''
  }

  return (
    <div className="files">
      <input ref={input} type="file" multiple hidden accept={accept(modalities)} onChange={(e) => add(e.target.files)} />
      {label && (
        <button type="button" className="link" onClick={() => input.current?.click()}>
          + Attach
        </button>
      )}
      <span className="hint">{reading ? `reading ${reading}…` : [label, modalities.vision && 'pdf'].filter(Boolean).join(' · ')}</span>
      {value.map((a) => (
        <span key={a.id} className={`chip${a.error ? ' bad' : ''}`} title={a.error || `${a.name} · ${a.note}`}>
          <span>{a.name}</span>
          <small>{a.error || a.note}</small>
          <button type="button" onClick={() => onChange(value.filter((x) => x.id !== a.id))} aria-label={`Remove ${a.name}`}>
            ×
          </button>
        </span>
      ))}
    </div>
  )
}
