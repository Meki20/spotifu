// Settings page — tabbed (Connection / Library / Appearance / API Keys / Accounts).
// Heavy lifting lives in components/settings/*.

import SettingsTabs from '../components/settings/SettingsTabs'

export default function Settings() {
  return (
    <div className="flex-1 overflow-y-auto w-full">
      <div className="mx-auto w-full max-w-5xl px-6 sm:px-10 md:px-14 lg:px-24 py-6">
        <h1
          className="text-3xl font-bold uppercase mb-5"
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 800,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            color: 'var(--text-primary)',
          }}
        >
          Settings
        </h1>
        <SettingsTabs />
      </div>
    </div>
  )
}
