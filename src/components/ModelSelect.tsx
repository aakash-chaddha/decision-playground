import { useCallback, useEffect, useState } from 'react'
import { listModels, type ModelInfo } from '../lib/api'
import { useSettings } from '../lib/settings'

// Model list straight from llama-server. Router mode reports which model is loaded; a single-model
// server lists its one model.
export function useModels() {
  const { server } = useSettings()
  const [models, setModels] = useState<ModelInfo[]>([])
  const [error, setError] = useState('')
  const refresh = useCallback(async (): Promise<ModelInfo[]> => {
    try {
      const list = await listModels(server)
      setModels(list)
      setError('')
      return list
    } catch (e) {
      setModels([])
      setError(`Cannot reach ${server}: ${(e as Error).message}`)
      return []
    }
  }, [server])
  useEffect(() => {
    refresh()
  }, [refresh])
  return { models, error, refresh }
}

export function ModelSelect({
  models,
  value,
  onChange,
  onRefresh,
}: {
  models: ModelInfo[]
  value: string
  onChange: (id: string) => void
  onRefresh: () => void
}) {
  return (
    <span className="ctl">
      <label htmlFor="model">Model</label>
      <select id="model" value={value} onChange={(e) => onChange(e.target.value)}>
        {!models.length && <option value="">no models</option>}
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.id}
            {m.status === 'loaded' ? ' ● loaded' : ''}
          </option>
        ))}
      </select>
      <button type="button" className="icon" onClick={onRefresh} title="Reload the model list" aria-label="Reload the model list">
        ↻
      </button>
    </span>
  )
}

// Keeps a model selection valid as the list changes, remembering the last choice per page.
export function useModelChoice(key: string, models: ModelInfo[]) {
  const [model, setModel] = useState(() => {
    try {
      return localStorage.getItem(`decision-playground.model.${key}`) || ''
    } catch {
      return ''
    }
  })
  const choose = (id: string) => {
    setModel(id)
    try {
      localStorage.setItem(`decision-playground.model.${key}`, id)
    } catch {
      /* not remembered */
    }
  }
  const valid = models.some((m) => m.id === model)
  const effective = valid ? model : (models.find((m) => m.status === 'loaded') || models[0])?.id || ''
  return [effective, choose] as const
}
