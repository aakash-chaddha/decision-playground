import { useEffect, useState } from 'react'
import { SettingsProvider, useSettings } from './lib/settings'
import { Playground } from './pages/Playground'
import { Game } from './pages/Game'

type Page = 'playground' | 'game'
const pageFromHash = (): Page => (location.hash.replace(/^#\/?/, '') === 'game' ? 'game' : 'playground')

function ServerSetting() {
  const { server, setServer } = useSettings()
  const [draft, setDraft] = useState(server)
  const [health, setHealth] = useState<'ok' | 'down' | 'checking'>('checking')
  useEffect(() => setDraft(server), [server])
  useEffect(() => {
    let alive = true
    const check = () =>
      fetch(`${server}/health`)
        .then((r) => alive && setHealth(r.ok ? 'ok' : 'down'))
        .catch(() => alive && setHealth('down'))
    setHealth('checking')
    check()
    const id = setInterval(check, 10000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [server])
  return (
    <form
      className="server"
      onSubmit={(e) => {
        e.preventDefault()
        setServer(draft)
      }}
    >
      <label htmlFor="server">llama-server</label>
      <span className={`health ${health}`} title={health === 'ok' ? 'Connected' : health === 'down' ? 'Not reachable' : 'Checking'} />
      <input id="server" spellCheck={false} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => draft !== server && setServer(draft)} />
    </form>
  )
}

export default function App() {
  const [page, setPage] = useState<Page>(pageFromHash)
  useEffect(() => {
    const onHash = () => setPage(pageFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  useEffect(() => {
    document.title = page === 'game' ? 'Decision Game' : 'Decision Playground'
  }, [page])
  return (
    <SettingsProvider>
      <div className="app">
        <header className="top">
          <h1>
            Decision <span>{page === 'game' ? 'Game' : 'Playground'}</span>
          </h1>
          <nav aria-label="Pages">
            <a href="#/playground" className={page === 'playground' ? 'on' : ''} aria-current={page === 'playground' ? 'page' : undefined}>
              Playground
            </a>
            <a href="#/game" className={page === 'game' ? 'on' : ''} aria-current={page === 'game' ? 'page' : undefined}>
              Game
            </a>
          </nav>
          <ServerSetting />
        </header>
        <main>{page === 'game' ? <Game /> : <Playground />}</main>
      </div>
    </SettingsProvider>
  )
}
