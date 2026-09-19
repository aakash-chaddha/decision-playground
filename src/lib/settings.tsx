import { createContext, useContext, useState, type ReactNode } from 'react'

// The app's only setting: the llama-server base URL. Everything else is talked to directly from the browser.
const KEY = 'decision-playground.server'
const FALLBACK = import.meta.env.VITE_DEFAULT_SERVER || 'http://localhost:8080'

function load(): string {
  try {
    return localStorage.getItem(KEY) || FALLBACK
  } catch {
    return FALLBACK
  }
}

interface Settings {
  server: string
  setServer: (url: string) => void
}

const SettingsContext = createContext<Settings>({ server: FALLBACK, setServer: () => {} })

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [server, setState] = useState(load)
  const setServer = (url: string) => {
    const clean = url.trim().replace(/\/+$/, '')
    setState(clean)
    try {
      localStorage.setItem(KEY, clean)
    } catch {
      /* not remembered in this browser */
    }
  }
  return <SettingsContext.Provider value={{ server, setServer }}>{children}</SettingsContext.Provider>
}

export const useSettings = () => useContext(SettingsContext)
