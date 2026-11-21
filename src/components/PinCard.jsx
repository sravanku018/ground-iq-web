import { useState } from 'react'
import { pinDisable, pinSetup } from '../api'
import PinPad from './PinPad'

/**
 * PinCard — opt-in 4-digit PIN quick-login management (profile screens).
 * Set / Change / Remove. The PIN only unlocks the same portal the password
 * opens, and guessing is locked out after 5 wrong attempts server-side.
 */
export default function PinCard({ user, onToast, onUpdated }) {
  const [hasPin, setHasPin] = useState(!!user?.has_pin)
  const [mode, setMode] = useState('view') // view | set
  const [pin, setPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function handleSet() {
    setError('')
    if (!/^\d{4}$/.test(pin)) {
      setError('The PIN must be exactly 4 digits.')
      return
    }
    if (pin !== confirmPin) {
      setError('The two PINs do not match.')
      return
    }
    setBusy(true)
    try {
      const res = await pinSetup(pin)
      if (res?.error) throw new Error(res.error)
      setHasPin(true)
      setMode('view')
      setPin('')
      setConfirmPin('')
      onToast?.('PIN quick-login saved — use it on the sign-in screen', 'ok')
      onUpdated?.({ has_pin: true })
    } catch (e) {
      setError(e.message || 'Could not save the PIN')
    } finally {
      setBusy(false)
    }
  }

  async function handleRemove() {
    if (!window.confirm('Remove the PIN? You will sign in with your password (or fingerprint/passkey).')) return
    setBusy(true)
    try {
      const res = await pinDisable()
      if (res?.error) throw new Error(res.error)
      setHasPin(false)
      setMode('view')
      setPin('')
      setConfirmPin('')
      onToast?.('PIN removed', 'ok')
      onUpdated?.({ has_pin: false })
    } catch (e) {
      setError(e.message || 'Could not remove the PIN')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card" style={{ marginBottom: 14, padding: 16 }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 800 }}>
        🔢 4-digit PIN quick-login
      </h3>
      <p className="muted" style={{ margin: '0 0 10px', fontSize: 12 }}>
        Opt-in convenience: sign in with a 4-digit PIN instead of your password —
        on this app and the sign-in screen. Guessing is locked out after 5 wrong
        attempts, and your password always works.
      </p>

      {error ? (
        <div className="banner error" role="alert" style={{ marginBottom: 8 }}>
          {error}
        </div>
      ) : null}

      {mode === 'view' ? (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <span className="pill ok" style={{ fontSize: 12 }}>
            <span className="dot" />
            {hasPin ? 'PIN enabled' : 'No PIN set'}
          </span>
          <button
            type="button"
            className="btn small primary"
            onClick={() => { setMode('set'); setPin(''); setConfirmPin(''); setError('') }}
          >
            {hasPin ? 'Change PIN' : 'Set a PIN'}
          </button>
          {hasPin && (
            <button type="button" className="btn small danger" disabled={busy} onClick={() => void handleRemove()}>
              Remove PIN
            </button>
          )}
        </div>
      ) : (
        <div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <PinPad value={pin} onChange={setPin} disabled={busy} autoFocus />
            <PinPad
              value={confirmPin}
              onChange={setConfirmPin}
              disabled={busy}
              autoFocus={false}
            />
            <span className="muted" style={{ fontSize: 11 }}>
              Type the PIN twice to confirm
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="btn primary"
              disabled={busy || pin.length !== 4 || pin !== confirmPin}
              onClick={() => void handleSet()}
              style={{ flex: 1 }}
            >
              {busy ? 'Saving…' : hasPin ? 'Change PIN' : 'Save PIN'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => { setMode('view'); setPin(''); setConfirmPin(''); setError('') }}
              style={{ flex: 1 }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
