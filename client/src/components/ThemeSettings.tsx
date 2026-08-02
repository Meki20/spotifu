// Appearance settings tab: theme presets + customizer.
//
// Lets the user pick a preset, tweak individual colors with native color
// pickers, generate a palette from one accent color, and save/load named
// custom themes. Live-updates the document via the theme store.

import { useMemo, useState } from 'react'
import { useThemeStore, normalizeVars } from '../stores/themeStore'
import {
  PRESET_THEMES,
  adjustLightness,
  getTheme,
  isValidHex,
  normalizeHex,
  paletteFromAccent,
} from '../lib/themes'

const TOKENS: { key: string; label: string }[] = [
  { key: '--bg-base', label: 'Page background' },
  { key: '--bg-surface', label: 'Card / surface' },
  { key: '--bg-surface-2', label: 'Elevated surface' },
  { key: '--bg-surface-3', label: 'Higher elevation' },
  { key: '--border', label: 'Border' },
  { key: '--border-subtle', label: 'Subtle border' },
  { key: '--accent', label: 'Accent (primary)' },
  { key: '--accent-hover', label: 'Accent hover' },
  { key: '--text-primary', label: 'Primary text' },
  { key: '--text-secondary', label: 'Secondary text' },
  { key: '--text-faint', label: 'Faint text' },
  { key: '--text-muted', label: 'Muted text' },
  { key: '--color-success', label: 'Success text' },
  { key: '--color-success-bg', label: 'Success background' },
  { key: '--color-danger', label: 'Danger text' },
  { key: '--color-danger-bg', label: 'Danger background' },
]

function isHexOnly(v: string): boolean {
  return /^#[0-9A-Fa-f]{6}$/.test(v.trim())
}

export default function ThemeSettings() {
  const activeId = useThemeStore((s) => s.activeId)
  const setActive = useThemeStore((s) => s.setActive)
  const applyCustom = useThemeStore((s) => s.applyCustom)
  const saveCustom = useThemeStore((s) => s.saveCustom)
  const deleteCustom = useThemeStore((s) => s.deleteCustom)

  const customs = useThemeStore((s) => s.customs)
  const baseTheme = useMemo(() => {
    const custom = customs.find((t) => t.id === activeId)
    return custom ?? getTheme(activeId)
  }, [activeId, customs])
  const [draftVars, setDraftVars] = useState<Record<string, string>>(() => ({ ...baseTheme.vars }))
  const [newName, setNewName] = useState('')
  const [saveStatus, setSaveStatus] = useState('')
  const [genSeed, setGenSeed] = useState('#b4003e')
  const [genDark, setGenDark] = useState(true)
  const [genError, setGenError] = useState('')
  const [bgUrl, setBgUrl] = useState(baseTheme.backgroundUrl ?? '')
  const [bgOpacity, setBgOpacity] = useState(baseTheme.backgroundOpacity ?? 0.15)
  const [flavor, setFlavor] = useState(baseTheme.flavor)

  function updateVar(key: string, value: string) {
    setDraftVars((d) => ({ ...d, [key]: value }))
  }

  function commitDraft() {
    const cleaned = normalizeVars(draftVars)
    applyCustom(cleaned, bgUrl, bgOpacity, flavor)
  }

  function handlePresetPick(id: string) {
    const theme = getTheme(id)
    setDraftVars({ ...theme.vars })
    setBgUrl(theme.backgroundUrl ?? '')
    setBgOpacity(theme.backgroundOpacity ?? 0.15)
    setFlavor(theme.flavor)
    setActive(id)
  }

  function handleGenerate() {
    setGenError('')
    if (!isValidHex(genSeed)) {
      setGenError('Seed must be a 6-digit hex (e.g. var(--accent)).')
      return
    }
    const seed = normalizeHex(genSeed)
    const generated = paletteFromAccent(seed, genDark)
    const merged = { ...draftVars, ...generated }
    setDraftVars(merged)
    const cleaned = normalizeVars(merged)
    applyCustom(cleaned, bgUrl, bgOpacity, flavor)
  }

  function handleRandomize() {
    const h = Math.floor(Math.random() * 360)
    const s = 55 + Math.random() * 35
    const l = 45 + Math.random() * 15
    // Convert HSL -> hex inline (avoid importing here just for one call).
    const k = (n: number) => (n + h / 30) % 12
    const a = (s / 100) * Math.min(l / 100, 1 - l / 100)
    const f = (n: number) =>
      l / 100 - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
    const toHex = (v: number) =>
      Math.round(v * 255).toString(16).padStart(2, '0')
    const hex = `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`
    setGenSeed(hex)
    const generated = paletteFromAccent(hex, genDark)
    const merged = { ...draftVars, ...generated }
    setDraftVars(merged)
    applyCustom(normalizeVars(merged), bgUrl, bgOpacity, flavor)
  }

  function handleSave() {
    setSaveStatus('')
    const cleaned = normalizeVars(draftVars)
    const id = saveCustom(newName, cleaned, bgUrl, bgOpacity, flavor)
    setNewName('')
    setSaveStatus(`Saved as "${getTheme(id).name}".`)
    setTimeout(() => setSaveStatus(''), 2500)
  }

  function handleResetToPreset() {
    if (activeId === '__custom__preview__' || customs.some((t) => t.id === activeId)) {
      const def = getTheme('polly-dark')
      setActive('polly-dark')
      setDraftVars({ ...def.vars })
      setBgUrl(def.backgroundUrl ?? '')
      setBgOpacity(def.backgroundOpacity ?? 0.15)
      setFlavor(def.flavor)
    }
  }

  return (
    <div className="space-y-6">
      {/* Presets */}
      <section>
        <SectionLabel>Presets</SectionLabel>
        <p className="text-xs mb-3" style={hint()}>
          Click a preset to apply it immediately. Tweak colors below to customize.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {PRESET_THEMES.map((preset) => {
            const isActive = activeId === preset.id
            return (
              <button
                key={preset.id}
                onClick={() => handlePresetPick(preset.id)}
                className="text-left rounded p-3 transition-all"
                style={{
                  background: isActive ? 'var(--bg-surface-2)' : 'var(--bg-surface)',
                  border: `1px solid ${isActive ? 'var(--accent)' : 'var(--border)'}`,
                  cursor: 'pointer',
                }}
              >
                <div
                  className="text-sm font-semibold mb-2"
                  style={{ fontFamily: 'var(--font-display)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-primary)' }}
                >
                  {preset.name}
                </div>
                <div className="flex gap-1">
                  <Swatch color={preset.vars['--bg-base']} />
                  <Swatch color={preset.vars['--bg-surface']} />
                  <Swatch color={preset.vars['--accent']} />
                  <Swatch color={preset.vars['--text-primary']} />
                </div>
              </button>
            )
          })}
        </div>
      </section>

      {/* Palette generator */}
      <section>
        <SectionLabel>Generate from one accent color</SectionLabel>
        <p className="text-xs mb-3" style={hint()}>
          Builds a full palette using the accent as a hue anchor. Adjusts lightness
          and saturation to fit light or dark mode.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs" style={label()}>Seed color</span>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={isValidHex(genSeed) ? normalizeHex(genSeed) : '#000000'}
                onChange={(e) => setGenSeed(e.target.value)}
                style={{ width: 40, height: 36, border: '1px solid var(--border)', borderRadius: 4, background: 'transparent', cursor: 'pointer' }}
              />
              <input
                type="text"
                value={genSeed}
                onChange={(e) => setGenSeed(e.target.value)}
                placeholder="var(--accent)"
                className="px-3 py-2 text-sm"
                style={inputStyle()}
              />
            </div>
          </label>
          <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-primary)' }}>
            <input
              type="checkbox"
              checked={genDark}
              onChange={(e) => setGenDark(e.target.checked)}
            />
            Dark mode
          </label>
          <button onClick={handleGenerate} style={primaryBtn()}>Generate</button>
          <button onClick={handleRandomize} style={secondaryBtn()}>Randomize</button>
        </div>
        {genError && <p className="text-xs mt-2" style={{ color: 'var(--color-danger)' }}>{genError}</p>}
      </section>

      {/* Customizer */}
      <section>
        <SectionLabel>Customize</SectionLabel>
        <p className="text-xs mb-3" style={hint()}>
          Each color picker updates the page in real time. Click <strong>Save</strong>
          to keep your edits as a named theme.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {TOKENS.map(({ key, label }) => {
            const value = draftVars[key] ?? '#000000'
            const supportsPicker = isHexOnly(value)
            return (
              <div
                key={key}
                className="flex items-center gap-3 p-2 rounded"
                style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
              >
                <input
                  type="color"
                  value={supportsPicker ? normalizeHex(value) : '#000000'}
                  onChange={(e) => updateVar(key, e.target.value)}
                  onBlur={commitDraft}
                  disabled={!supportsPicker}
                  style={{
                    width: 36,
                    height: 36,
                    border: '1px solid var(--border)',
                    borderRadius: 4,
                    background: 'transparent',
                    cursor: supportsPicker ? 'pointer' : 'not-allowed',
                    opacity: supportsPicker ? 1 : 0.4,
                  }}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-xs" style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-display)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>
                    {label}
                  </div>
                  <input
                    type="text"
                    value={value}
                    onChange={(e) => updateVar(key, e.target.value)}
                    onBlur={commitDraft}
                    className="w-full px-2 py-1 text-xs mt-0.5"
                    style={{ ...inputStyle(), fontFamily: 'var(--font-mono)' }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      </section>

      {/* Background image */}
      <section>
        <SectionLabel>Background image</SectionLabel>
        <p className="text-xs mb-3" style={hint()}>
          Optionally set a background image URL. Applied at low opacity so it
          never competes with interface content.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex-1 min-w-[200px] flex flex-col gap-1">
            <span className="text-xs" style={label()}>Image URL</span>
            <input
              type="text"
              value={bgUrl}
              onChange={(e) => {
                const url = e.target.value
                setBgUrl(url)
                const cleaned = normalizeVars(draftVars)
                applyCustom(cleaned, url, bgOpacity, flavor)
              }}
              placeholder="https://example.com/bg.jpg"
              className="w-full px-3 py-2 text-sm"
              style={inputStyle()}
            />
          </label>
          <label className="flex flex-col gap-1" style={{ width: 100 }}>
            <span className="text-xs" style={label()}>Opacity</span>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min="0"
                max="0.5"
                step="0.01"
                value={bgOpacity}
                onChange={(e) => {
                  const v = parseFloat(e.target.value)
                  setBgOpacity(v)
                  const cleaned = normalizeVars(draftVars)
                  applyCustom(cleaned, bgUrl, v, flavor)
                }}
                style={{ flex: 1, accentColor: 'var(--accent)' }}
              />
              <span className="text-xs font-mono" style={{ color: 'var(--text-secondary)', width: 32, textAlign: 'right' }}>
                {Math.round(bgOpacity * 100)}%
              </span>
            </div>
          </label>
        </div>
      </section>

      {/* Save / load */}
      <section>
        <SectionLabel>Save current as new theme</SectionLabel>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Theme name"
            className="px-3 py-2 text-sm flex-1 min-w-[200px]"
            style={inputStyle()}
          />
          <button onClick={handleSave} disabled={!newName.trim()} style={primaryBtn()}>Save</button>
          {saveStatus && <span className="text-xs" style={{ color: 'var(--color-success)' }}>{saveStatus}</span>}
        </div>
        {customs.length > 0 && (
          <div className="mt-4 space-y-2">
            {customs.map((theme) => (
              <div
                key={theme.id}
                className="flex items-center gap-3 p-2 rounded"
                style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
              >
                <div className="flex gap-1">
                  <Swatch color={theme.vars['--bg-base']} />
                  <Swatch color={theme.vars['--accent']} />
                  <Swatch color={theme.vars['--text-primary']} />
                </div>
                <button
                  onClick={() => {
                    setDraftVars({ ...theme.vars })
                    setBgUrl(theme.backgroundUrl ?? '')
                    setBgOpacity(theme.backgroundOpacity ?? 0.15)
                    setFlavor(theme.flavor)
                    setActive(theme.id)
                  }}
                  className="flex-1 text-left text-sm"
                  style={{
                    color: activeId === theme.id ? 'var(--accent)' : 'var(--text-primary)',
                    fontWeight: activeId === theme.id ? 700 : 500,
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                  }}
                >
                  {theme.name}
                </button>
                <button onClick={() => deleteCustom(theme.id)} style={dangerBtn()}>Delete</button>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="flex items-center gap-2">
        <button onClick={handleResetToPreset} style={secondaryBtn()}>Reset to default</button>
        <span className="text-xs" style={hint()}>
          Tip: exported theme is stored in your browser only. Re-installing or
          clearing site data will reset to <strong>Polly Dark</strong>.
        </span>
      </div>
    </div>
  )
}

// ── Local style helpers (kept inline since this component is the only consumer) ──

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mb-2 pb-1.5"
      style={{
        fontFamily: 'var(--font-display)',
        fontSize: 14,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.12em',
        color: 'var(--accent)',
        borderBottom: '1px solid var(--border-subtle)',
      }}
    >
      {children}
    </div>
  )
}

function hint(): React.CSSProperties {
  return { color: 'var(--text-secondary)', fontFamily: 'var(--font-body)', fontSize: 13 }
}
function label(): React.CSSProperties {
  return { color: 'var(--text-secondary)', fontFamily: 'var(--font-body)', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }
}
function inputStyle(): React.CSSProperties {
  return {
    background: 'var(--bg-base)',
    border: '1px solid var(--border)',
    borderRadius: 4,
    fontFamily: 'var(--font-mono)',
    fontSize: 14,
    color: 'var(--text-primary)',
    padding: '4px 8px',
    outline: 'none',
    boxSizing: 'border-box',
  }
}
function primaryBtn(): React.CSSProperties {
  return {
    background: 'var(--accent)',
    color: 'var(--text-primary)',
    border: 'none',
    borderRadius: 4,
    padding: '8px 14px',
    fontFamily: 'var(--font-display)',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    fontSize: 13,
    cursor: 'pointer',
  }
}
function secondaryBtn(): React.CSSProperties {
  return {
    background: 'transparent',
    color: 'var(--text-secondary)',
    border: '1px solid var(--border)',
    borderRadius: 4,
    padding: '8px 14px',
    fontFamily: 'var(--font-display)',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    fontSize: 13,
    cursor: 'pointer',
  }
}
function dangerBtn(): React.CSSProperties {
  return {
    background: 'var(--color-danger-faint-bg, rgba(196, 48, 43, 0.15))',
    color: 'var(--color-danger)',
    border: 'none',
    borderRadius: 4,
    padding: '4px 10px',
    fontFamily: 'var(--font-display)',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    fontSize: 11,
    cursor: 'pointer',
  }
}

function Swatch({ color }: { color: string }) {
  const safe = isHexOnly(color) ? normalizeHex(color) : '#888888'
  return (
    <div
      title={safe}
      style={{
        width: 22,
        height: 22,
        background: safe,
        border: '1px solid var(--border)',
        borderRadius: 4,
      }}
    />
  )
}

// suppress unused-import warning for `adjustLightness` (kept exported from themes.ts)
void adjustLightness
