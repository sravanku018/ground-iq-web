import { useEffect, useRef } from 'react'

/**
 * PinPad - always shows `length` (default 4) PIN slots + on-screen keypad.
 * Props: value, onChange(str), onComplete(str), disabled, autoFocus, length.
 * Self-contained inline styles; colours inherit from the parent (works on dark and light).
 */
export default function PinPad({
  value = '',
  onChange,
  onComplete,
  disabled = false,
  autoFocus = true,
  length = 4,
}) {
  const inputRef = useRef(null)
  const v = String(value || '').replace(/\D/g, '').slice(0, length)

  useEffect(() => {
    if (autoFocus && !disabled) inputRef.current?.focus()
  }, [autoFocus, disabled])

  function update(next) {
    const clean = String(next).replace(/\D/g, '').slice(0, length)
    onChange?.(clean)
    if (clean.length === length && v.length < length) onComplete?.(clean)
  }

  const keyStyle = {
    height: 48,
    fontSize: 20,
    fontWeight: 600,
    borderRadius: 10,
    border: '1px solid currentColor',
    borderColor: 'rgba(148,163,184,0.45)',
    background: 'rgba(148,163,184,0.12)',
    color: 'inherit',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  }

  return (
    <div
      style={{ position: 'relative', width: 240, maxWidth: '100%', color: 'inherit' }}
      onClick={() => inputRef.current?.focus()}
    >
      {/* hidden input: physical keyboard support, no soft keyboard on phones */}
      <input
        ref={inputRef}
        value={v}
        onChange={(e) => update(e.target.value)}
        disabled={disabled}
        inputMode="none"
        autoComplete="off"
        aria-label={`${length}-digit PIN`}
        style={{ position: 'absolute', opacity: 0, pointerEvents: 'none', width: 1, height: 1 }}
      />

      <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginBottom: 14 }}>
        {Array.from({ length }).map((_, i) => {
          const filled = i < v.length
          const current = i === v.length
          return (
            <div
              key={i}
              style={{
                width: 44,
                height: 52,
                borderRadius: 10,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: current ? '2px solid #4f7dc6' : '2px solid rgba(148,163,184,0.6)',
                background: 'rgba(148,163,184,0.12)',
              }}
            >
              {filled ? (
                <span style={{ width: 12, height: 12, borderRadius: '50%', background: 'currentColor' }} />
              ) : null}
            </div>
          )
        })}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button key={d} type="button" style={keyStyle} disabled={disabled} onClick={() => update(v + d)}>
            {d}
          </button>
        ))}
        <span />
        <button type="button" style={keyStyle} disabled={disabled} onClick={() => update(v + '0')}>
          0
        </button>
        <button
          type="button"
          style={keyStyle}
          disabled={disabled}
          aria-label="Backspace"
          onClick={() => onChange?.(v.slice(0, -1))}
        >
          ⌫
        </button>
      </div>
    </div>
  )
}
