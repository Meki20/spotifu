import { useEffect, useState } from 'react'
import { useConnectionStore } from '../config/connectionStore'
import { probeServerUrl } from '../config/discoverServer'
import ServerConnectionPanel from './ServerConnectionPanel'
import { PollyLoading } from './PollyLoading'

export default function RequireServerConnection({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<'checking' | 'connected' | 'unreachable'>('checking')

  useEffect(() => {
    useConnectionStore.getState().seedFromEnv()
    void (async () => {
      setStatus('checking')
      const ok = await probeServerUrl(useConnectionStore.getState().getEffectiveApiUrl())
      setStatus(ok ? 'connected' : 'unreachable')
    })()
  }, [])

  if (status === 'checking') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-[#121212]">
        <PollyLoading size={56} />
        <span className="text-xs" style={{ color: '#9A8E84', fontFamily: "'Barlow Semi Condensed', sans-serif" }}>
          Connecting to server…
        </span>
      </div>
    )
  }

  if (status === 'unreachable') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#121212] p-6">
        <div className="bg-[#181818] p-8 rounded-lg w-full max-w-md space-y-4">
          <h1
            className="text-2xl font-bold text-white"
            style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800 }}
          >
            Connect to SpotiFU server
          </h1>
          <p className="text-sm text-[#9A8E84]" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif" }}>
            Find your server on the LAN or enter its address manually.
          </p>
          <ServerConnectionPanel onConnected={() => setStatus('connected')} />
        </div>
      </div>
    )
  }

  return <>{children}</>
}
