// Settings → API Keys tab: Fanart.tv + Last.fm.

import { useEffect, useState } from 'react'
import { ApiKeyRow } from './ApiKeyRow'
import { SectionLabel, SectionHint } from './Section'
import { authFetch } from '../../api'

interface ServerSettings {
  fanarttv_key_configured: boolean
  lastfm_key_configured: boolean
}

export default function SettingsApiKeys() {
  const [settings, setSettings] = useState<ServerSettings | null>(null)
  const [fanartKey, setFanartKey] = useState('')
  const [fanartStatus, setFanartStatus] = useState('')
  const [fanartLoading, setFanartLoading] = useState(false)
  const [lastfmKey, setLastfmKey] = useState('')
  const [lastfmStatus, setLastfmStatus] = useState('')
  const [lastfmLoading, setLastfmLoading] = useState(false)

  useEffect(() => {
    authFetch('/settings')
      .then(async (r) => {
        if (!r.ok) return
        setSettings(await r.json())
      })
      .catch(console.error)
  }, [])

  async function handleFanartSubmit(e: React.FormEvent) {
    e.preventDefault()
    setFanartLoading(true)
    setFanartStatus('')
    try {
      const res = await authFetch('/settings/fanart', {
        method: 'POST',
        body: JSON.stringify({ api_key: fanartKey }),
      })
      if (!res.ok) throw new Error('Failed to save')
      setFanartKey('')
      setFanartStatus('Saved')
      const settingsRes = await authFetch('/settings')
      setSettings(await settingsRes.json())
    } catch (err) {
      setFanartStatus('Error: ' + String(err))
    } finally {
      setFanartLoading(false)
    }
  }

  async function handleLastfmSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLastfmLoading(true)
    setLastfmStatus('')
    try {
      const res = await authFetch('/settings/lastfm', {
        method: 'POST',
        body: JSON.stringify({ api_key: lastfmKey }),
      })
      if (!res.ok) throw new Error('Failed to save')
      setLastfmKey('')
      setLastfmStatus('Saved')
      const settingsRes = await authFetch('/settings')
      setSettings(await settingsRes.json())
    } catch (err) {
      setLastfmStatus('Error: ' + String(err))
    } finally {
      setLastfmLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <section>
        <SectionLabel>Provider API Keys</SectionLabel>
        <SectionHint>
          Fanart.tv enables higher-quality artist images. Last.fm can power similarity + tags.
          Keys are stored locally in your <code>.secrets</code>.
        </SectionHint>

        <div className="space-y-4">
          <ApiKeyRow
            label="Fanart.tv"
            configured={Boolean(settings?.fanarttv_key_configured)}
            value={fanartKey}
            onChange={setFanartKey}
            onSubmit={handleFanartSubmit}
            loading={fanartLoading}
            status={fanartStatus}
            placeholder="Fanart.tv API key"
          />
          <ApiKeyRow
            label="Last.fm"
            configured={Boolean(settings?.lastfm_key_configured)}
            value={lastfmKey}
            onChange={setLastfmKey}
            onSubmit={handleLastfmSubmit}
            loading={lastfmLoading}
            status={lastfmStatus}
            placeholder="Last.fm API key"
          />
        </div>
      </section>
    </div>
  )
}
