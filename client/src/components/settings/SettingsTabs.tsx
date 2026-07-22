// Tabbed navigation for Settings. Hash-based so tabs are deep-linkable
// and survive reloads without route changes.

import { useEffect, useState, type ReactNode } from 'react'
import SettingsConnection from './SettingsConnection'
import SettingsLibrary from './SettingsLibrary'
import SettingsApiKeys from './SettingsApiKeys'
import SettingsAccounts from './SettingsAccounts'
import ThemeSettings from '../ThemeSettings'

interface Tab {
  id: string
  label: string
  render: () => ReactNode
}

const TABS: Tab[] = [
  { id: 'connection', label: 'Connection', render: () => <SettingsConnection /> },
  { id: 'library', label: 'Library', render: () => <SettingsLibrary /> },
  { id: 'appearance', label: 'Appearance', render: () => <ThemeSettings /> },
  { id: 'api-keys', label: 'API Keys', render: () => <SettingsApiKeys /> },
  { id: 'accounts', label: 'Accounts', render: () => <SettingsAccounts /> },
]

const DEFAULT_TAB = 'connection'

function readTabFromHash(): string {
  const raw = window.location.hash.replace(/^#/, '').trim()
  return TABS.some((t) => t.id === raw) ? raw : DEFAULT_TAB
}

export default function SettingsTabs() {
  const [active, setActive] = useState<string>(() => readTabFromHash())

  useEffect(() => {
    function onHashChange() {
      setActive(readTabFromHash())
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  function selectTab(id: string) {
    setActive(id)
    if (window.location.hash !== `#${id}`) {
      window.history.replaceState(null, '', `#${id}`)
    }
  }

  const activeTab = TABS.find((t) => t.id === active) ?? TABS[0]

  return (
    <div>
      <div
        role="tablist"
        className="flex flex-wrap gap-1 mb-6 pb-2"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        {TABS.map((tab) => {
          const isActive = tab.id === activeTab.id
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              onClick={() => selectTab(tab.id)}
              className="px-4 py-2 text-sm transition-colors"
              style={{
                fontFamily: 'var(--font-display)',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
                background: 'transparent',
                border: 'none',
                borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                marginBottom: '-1px',
                cursor: 'pointer',
              }}
            >
              {tab.label}
            </button>
          )
        })}
      </div>
      <div role="tabpanel">{activeTab.render()}</div>
    </div>
  )
}
