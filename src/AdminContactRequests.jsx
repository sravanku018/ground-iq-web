/**
 * Super Admin → Contact Requests: every message sent from the landing-page
 * contact form (name, email, compulsory purpose, optional message).
 */
import { useCallback, useEffect, useState } from 'react'
import { getContactRequests, setContactRequestStatus } from './api'

function fmt(value) {
  const d = new Date(value || '')
  if (Number.isNaN(d.getTime())) return '—'
  try {
    return new Intl.DateTimeFormat('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
    }).format(d)
  } catch {
    return d.toLocaleString()
  }
}

export default function AdminContactRequests({ onToast }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [filter, setFilter] = useState('all')

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const res = await getContactRequests()
      setItems(Array.isArray(res?.items) ? res.items : [])
    } catch (e) {
      onToast?.(e?.message || 'Could not load contact requests', 'error')
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [onToast])

  useEffect(() => {
    void load()
  }, [load])

  const toggleHandled = async (row) => {
    setBusyId(row.id)
    try {
      const next = row.status === 'handled' ? 'new' : 'handled'
      await setContactRequestStatus(row.id, next)
      setItems((list) => list.map((r) => (r.id === row.id ? { ...r, status: next } : r)))
      onToast?.(next === 'handled' ? 'Marked as handled ✓' : 'Marked as new', 'ok')
    } catch (e) {
      onToast?.(e?.message || 'Update failed', 'error')
    } finally {
      setBusyId(null)
    }
  }

  const shown = items.filter((r) => (filter === 'all' ? true : r.status === filter))
  const newCount = items.filter((r) => r.status !== 'handled').length

  return (
    <div className="portal-page">
      <header className="portal-page-head">
        <div>
          <p className="eyebrow">Super Admin</p>
          <h1>Contact Requests</h1>
          <p className="portal-lead">
            Messages from the landing page contact form · delivered to smartsurveyx@gmail.com · {newCount} new
          </p>
        </div>
        <button type="button" className="btn small" onClick={() => void load()}>Refresh</button>
      </header>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        {[
          ['all', `All (${items.length})`],
          ['new', `New (${newCount})`],
          ['handled', `Handled (${items.length - newCount})`],
        ].map(([k, label]) => (
          <button
            key={k}
            type="button"
            className={`btn small ${filter === k ? 'primary' : ''}`}
            onClick={() => setFilter(k)}
          >
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="card" style={{ padding: 16 }}>Loading…</div>
      ) : shown.length === 0 ? (
        <div className="card muted" style={{ padding: 16 }}>
          No contact requests {filter === 'all' ? 'yet' : `with status “${filter}”`}.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {shown.map((r) => (
            <div
              key={r.id}
              className="card"
              style={{
                padding: 14,
                borderLeft: `4px solid ${r.status === 'handled' ? '#16a34a' : '#f59e0b'}`,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                <div>
                  <strong style={{ fontSize: 14 }}>{r.name}</strong>
                  <span className="muted" style={{ fontSize: 12 }}> · {fmt(r.created_at)}</span>
                  <div style={{ fontSize: 13, marginTop: 2 }}>
                    <a href={`mailto:${r.email}?subject=Re: ${encodeURIComponent(r.purpose || 'Your request')}`} style={{ color: '#1a73e8', fontWeight: 600 }}>
                      {r.email}
                    </a>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      padding: '2px 10px',
                      borderRadius: 999,
                      background: r.status === 'handled' ? '#dcfce7' : '#fef3c7',
                      color: r.status === 'handled' ? '#15803d' : '#b45309',
                    }}
                  >
                    {r.status === 'handled' ? 'Handled' : 'New'}
                  </span>
                  <button
                    type="button"
                    className="btn small"
                    disabled={busyId === r.id}
                    onClick={() => void toggleHandled(r)}
                  >
                    {busyId === r.id ? '…' : r.status === 'handled' ? 'Mark new' : 'Mark handled'}
                  </button>
                </div>
              </div>
              <div style={{ marginTop: 8, fontSize: 13 }}>
                <span className="muted" style={{ fontSize: 11 }}>PURPOSE</span>
                <div style={{ fontWeight: 600 }}>{r.purpose}</div>
              </div>
              {r.message ? (
                <div style={{ marginTop: 6, fontSize: 13, color: '#334155', whiteSpace: 'pre-wrap' }}>
                  {r.message}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
