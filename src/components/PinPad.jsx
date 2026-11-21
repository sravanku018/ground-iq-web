import { useEffect } from 'react'

/**
 * PinPad — shared 4-digit PIN input (PIN quick-login).
 * One visible numeric input, dots via type="password"; fires onComplete
 * as soon as the 4th digit lands.
 */
export default function PinPad({ value, onChange, onComplete, disabled = false, autoFocus = true }) {
  useEffect(() => {
    if (String(value || '').length === 4 && onComplete) {
      onComplete(String(value))
    }
  }, [value, onComplete])

  return (
    <input
      type="password"
      inputMode="numeric"
      autoComplete="one-time-code"
      autoFocus={autoFocus}
      disabled={disabled}
      value={value}
      maxLength={4}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 4))}
      aria-label="4-digit PIN"
      style={{
        width: 180, height: 56, fontSize: 30, fontWeight: 800,
        letterSpacing: '0.9em', paddingLeft: '0.9em', textAlign: 'center',
        border: '2px solid #cbd5e1', borderRadius: 10, background: '#fff',
        color: '#1e293b', outline: 'none',
      }}
    />
  )
}
