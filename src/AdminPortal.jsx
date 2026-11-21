import { Component, Fragment, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Icon from './Icons'
import logoMark from './assets/logo-mark.png'
import {
  clearSession,
  apkDownloadUrl,
  fieldAppUrl,
  getClientAdminBreakdown,
  getStats,
  getStoredUser,
  getToken,
  listSubmissions,
  listSurveys,
  listUsers,
  logout,

  me,
} from './api'
import { reportError } from './errorReporter'
import useAppRelease from './useAppRelease'
import QuotaIndicator from './components/QuotaIndicator'
import AdminLogin from './AdminLogin'
import VerifiedBadge from './VerifiedBadge'
import { PortalSkeleton } from './PortalUI'
import { claimReload, isChunkLoadError, reloadSoon, hardReload } from './reloadGuard'
import AdminBell from './AdminBell'
import { fetchInboxCounts, useInboxCounts } from './inboxCounts'
import SetupChecklist from './components/SetupChecklist'
import QuotaLine from './components/QuotaLine'
import useIdleTimeout from './hooks/useIdleTimeout'
import { useIsNarrow } from './hooks/useIsNarrow'
import './App.css'
import './portal.css'

// Lazy-load heavy admin screens — only fetch/parse when that tab is opened
const AdminUsersScreen = lazy(() => import('./AdminUsers'))
const AdminSurveysScreen = lazy(() => import('./AdminSurveys'))
const AdminQuestionsScreen = lazy(() => import('./AdminQuestions'))
const AdminConversationsScreen = lazy(() => import('./AdminConversations'))
const ReviewQAScreen = lazy(() => import('./ReviewQA'))
const DashboardScreen = lazy(() => import('./Dashboard'))
const AdminDataScreen = lazy(() => import('./AdminData'))
const AdminQuestionBankScreen = lazy(() => import('./AdminQuestionBank'))
const AdminClientsScreen = lazy(() => import('./AdminClients'))
const AdminInboxScreen = lazy(() => import('./AdminInbox'))
const AdminLogsScreen = lazy(() => import('./AdminLogs'))
const AdminWebSurveyScreen = lazy(() => import('./AdminWebSurvey'))
const AdminProfileScreen = lazy(() => import('./AdminProfile'))
const AdminSubAdminsScreen = lazy(() => import('./AdminSubAdmins'))
const AdminExploreScreen = lazy(() => import('./AdminExplore'))

// Matches the sidebar: each group’s `pages` become the subtabs on that screen.
const NAV = [
  { id: 'overview', label: 'Dashboard', icon: 'grid', pages: ['overview'] },
  { id: 'analyze', label: 'Analyze & Export', icon: 'chart', pages: ['analyze', 'explore', 'data'] },
  { id: 'review', label: 'Review QA', icon: 'check', pages: ['review', 'conversations'] },
  { id: 'surveyors', label: 'Surveyors', icon: 'user', pages: ['users'] },
  { id: 'subadmins', label: 'Sub Admins', icon: 'shield', pages: ['subadmins'] },
  { id: 'surveys', label: 'Surveys & Forms', icon: 'clipboard', pages: ['surveys', 'questions', 'web', 'bank'] },
  { id: 'profile', label: 'Organization', icon: 'building', pages: ['profile'] },
]

const CLIENTS_NAV = {
  id: 'clients',
  label: 'Clients',
  icon: 'shield',
  pages: ['clients'],
}

const INBOX_NAV = {
  id: 'inbox',
  label: 'Inbox',
  icon: 'phone',
  pages: ['inbox'],
}

const LOGS_NAV = {
  id: 'logs',
  label: 'Logs',
  icon: 'lock',
  pages: ['logs'],
}

// Governance 5 -> 3 (WS7): old page ids land on the merged screens
const LEGACY_PAGE = { companies: 'clients', admins: 'clients', contact: 'inbox', seats: 'inbox', errors: 'logs', audit: 'logs' }

const PAGE_LABELS = {
  overview: 'Overview',
  analyze: 'Dashboard',
  charts: 'Excel Charts',
  explore: 'Explore',
  data: 'Data',
  report: 'Live Feed',
  users: 'Surveyors',
  subadmins: 'Sub Admins',
  surveys: 'Surveys',
  questions: 'Questions',
  review: 'Review',
  upload: 'Export',
  conversations: 'Conversations',
  audit: 'Audit Log',
  bank: 'Question Bank',
  web: 'Web survey',
  seats: 'Seat Requests',
  profile: 'Organization',
  admins: 'Client Admins',
  companies: 'Companies',
  contact: 'Contact Requests',
  errors: 'Errors',
  clients: 'Clients',
  inbox: 'Inbox',
  logs: 'Logs',
}

// All standard survey management, analytics, export, review, and web survey screens are visible to Client Admin.
const PAGE_POWER = {
  charts: 'can_excel_charts',
  conversations: 'can_converse',
  web: 'can_web_survey',
}


/**
 * Catches lazy chunk load failures (stale cached bundle → removed hashed chunk
 * returns 404). Auto-recovers by reloading once so the fresh index.html is
 * served; a cooldown prevents reload loops if the chunk keeps failing.
 */
class ChunkErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false, reloading: false, error: null }
  }
  static getDerivedStateFromError(error) {
    return { failed: true, error }
  }
  componentDidCatch(error) {
    reportError(error, { kind: 'portal-boundary' })
    if (!isChunkLoadError(error) || this.state.reloading) return
    // One attempt per shared cooldown; past that the card below stands, so a
    // genuinely broken deploy cannot put the tab in a reload loop.
    if (!claimReload()) return
    this.setState({ reloading: true })
    reloadSoon()
  }
  render() {
    if (this.state.failed) {
      return (
        <div className="portal-page">
          <div className="card" style={{ padding: 24, textAlign: 'center' }}>
            <h3>{this.state.reloading ? 'Reloading…' : 'This screen could not be loaded'}</h3>
            {!this.state.reloading && isChunkLoadError(this.state.error) && (
              <p className="muted">A new version may have been deployed. Reload to continue.</p>
            )}
            {!this.state.reloading && !isChunkLoadError(this.state.error) && this.state.error && (
              <p style={{ color: 'var(--danger)', fontSize: 13 }}>
                {String(this.state.error?.message || this.state.error)}
              </p>
            )}
            {!this.state.reloading && (
              <button
                type="button"
                className="btn primary"
                onClick={() => hardReload()}
              >
                Reload now
              </button>
            )}
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

function Overview({ user, stats, onNav, superAdminOnly = false, canPage = () => true }) {
  const isSuper = superAdminOnly || user?.role === 'super_admin'
  const gated = (p) => {
    // Super Admin (or console mode) always sees every feature
    if (isSuper) return true
    return canPage(p)
  }

  const [recentItems, setRecentItems] = useState([])
  const [surveyBreak, setSurveyBreak] = useState([])
  const [surveyorCount, setSurveyorCount] = useState(0)
  const [loadingRecent, setLoadingRecent] = useState(true)
  const [activityFilter, setActivityFilter] = useState('all')
  const [clientBreakdown, setClientBreakdown] = useState([])
  const [loadingBreakdown, setLoadingBreakdown] = useState(false)
  const [expandedAdmins, setExpandedAdmins] = useState({})

  // "Get started" checklist: per-account dismiss, remembered in this browser
  const checklistKey = `ssx_checklist_hidden_${String(user?.id ?? 'anon')}`
  const [checklistHidden, setChecklistHidden] = useState(() => {
    try { return localStorage.getItem(checklistKey) === '1' } catch { return false }
  })
  const hideChecklist = () => {
    setChecklistHidden(true)
    try { localStorage.setItem(checklistKey, '1') } catch { /* private mode */ }
  }

  const toggleAdmin = (id) => {
    setExpandedAdmins((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  const allotCap = Number(user?.max_records) || 0
  const webPending = Number(stats?.web_pending) || 0
  const webConfirmed = Number(stats?.web_confirmed) || 0
  const webRejected = Number(stats?.web_rejected) || 0
  const webSubmitted = Number(stats?.web_submissions) || webPending + webConfirmed + webRejected
  const fieldPending = Number(stats?.field_pending ?? stats?.pending) || 0
  const fieldConfirmed = Number(stats?.field_confirmed ?? stats?.confirmed) || 0
  const reviewPending = Number(stats?.pending) || fieldPending + webPending
  const confirmedTotal = Number(stats?.confirmed) || fieldConfirmed + webConfirmed
  const rejectedTotal = Number(stats?.rejected) || (Number(stats?.field_rejected) || 0) + webRejected
  const allSubmitted = Number(stats?.submissions) || fieldPending + fieldConfirmed + rejectedTotal + webSubmitted
  const fieldUsed = Math.max(fieldPending + fieldConfirmed, Number(stats?.field_submissions) || 0)
  const webReserved = surveyBreak.reduce(
    (n, s) => n + (Number(s.web_link?.max_uses) || 0),
    0,
  ) || Number(user?.web_reserved) || 0
  const fieldLeft = allotCap > 0 ? Math.max(0, allotCap - fieldUsed - webReserved) : null

  const surveysQuestionsSum = surveyBreak.reduce(
    (sum, s) => sum + (Number(s.question_count) || (Array.isArray(s.questions) ? s.questions.length : 0)),
    0,
  )
  const totalQuestionsUsed = Math.max(Number(user?.question_count) || 0, surveysQuestionsSum)

  useEffect(() => {
    let alive = true
    listSubmissions(100, 'all', {})
      .then((d) => {
        if (alive) setRecentItems(d.items || [])
      })
      .catch(() => {
        if (alive) setRecentItems([])
      })
      .finally(() => {
        if (alive) setLoadingRecent(false)
      })

    listSurveys()
      .then((d) => {
        if (!alive) return
        const items = (d.items || []).filter(
          (s) => s.form_key !== 'default' && s.form_key !== 'legacy',
        )
        setSurveyBreak(items)
      })
      .catch(() => {
        if (alive) setSurveyBreak([])
      })

    listUsers()
      .then((d) => {
        if (!alive) return
        const surveyors = d.users || d.surveyors || (Array.isArray(d) ? d : [])
        setSurveyorCount(surveyors.length)
      })
      .catch((e) => console.warn('[portal] surveyor list failed', e))

    if (isSuper) {
      setLoadingBreakdown(true)
      getClientAdminBreakdown()
        .then((d) => {
          if (alive) setClientBreakdown(d.items || [])
        })
        .catch((e) => console.warn('[portal] client admin breakdown failed', e))
        .finally(() => {
          if (alive) setLoadingBreakdown(false)
        })
    }

    return () => {
      alive = false
    }
  }, [stats?.submissions, isSuper])

  const pendingCount = reviewPending
  const confirmedCount = confirmedTotal
  const rejectedCount = rejectedTotal
  const liveAllCount = allSubmitted

  // Only a NEW account needs onboarding: hide once records were reviewed or the account is 2+ weeks old
  const createdMs = Date.parse(user?.created_at || user?.createdAt || '')
  const accountAgeDays = Number.isFinite(createdMs) ? (Date.now() - createdMs) / 86400000 : 0
  const isEstablished = confirmedCount + rejectedCount > 0 || accountAgeDays > 14
  const showChecklist = !isSuper && !checklistHidden && !isEstablished

  const displayedItems = recentItems.filter((it) => {
    const isWeb = it.source === 'web-survey' || it.source === 'web'
    if (activityFilter === 'web') return isWeb
    if (activityFilter === 'all') return true
    const st = it.status || 'pending'
    return st === activityFilter
  })
  const liveWebCount = recentItems.filter((it) => it.source === 'web-survey' || it.source === 'web').length
  const webSubmittedView = webSubmitted
  const fieldUsedView = fieldUsed
  const districtsView = stats?.districts ?? '—'


  return (
    <div className="portal-page">
      <header className="portal-page-head">
        <div>
          <p className="eyebrow">{superAdminOnly ? 'Super Admin Console' : 'Client Admin'}</p>
          <h1>Overview</h1>
          <p className="portal-lead">
            Welcome, {user?.name || user?.username} · Google + Twitter data review pipeline
          </p>
        </div>
      </header>

      {showChecklist && (
        <>
          <SetupChecklist
            surveys={surveyBreak}
            surveyorCount={surveyorCount}
            confirmed={confirmedTotal}
            rejected={rejectedTotal}
            onNav={onNav}
          />
          <div style={{ textAlign: 'right', margin: '-6px 0 12px' }}>
            <button type="button" className="btn small" onClick={hideChecklist}>
              Hide checklist
            </button>
          </div>
        </>
      )}

      {/* KPI tiles — Mock 3 style with Total Allocations and Rejected */}
      <div className="portal-kpi-grid">
        <button type="button" className="portal-kpi" onClick={() => onNav('review')}>
          <strong>{pendingCount.toLocaleString()}</strong>
          <span>Pending review</span>
        </button>
        <button type="button" className="portal-kpi" onClick={() => onNav(gated('review') ? 'review' : 'analyze')}>
          <strong>{confirmedCount.toLocaleString()}</strong>
          <span>Confirmed</span>
        </button>
        <button type="button" className="portal-kpi" onClick={() => onNav('review')}>
          <strong style={{ color: rejectedCount > 0 ? '#ef4444' : undefined }}>
            {rejectedCount.toLocaleString()}
          </strong>
          <span>Rejected</span>
        </button>
        <button type="button" className="portal-kpi" onClick={() => onNav(gated('report') ? 'report' : 'analyze')}>
          <strong>{liveAllCount.toLocaleString()}</strong>
          <span>{webSubmittedView > 0 ? `All submissions · ${webSubmittedView} web` : 'All submissions'}</span>
        </button>
        <button type="button" className="portal-kpi" onClick={() => onNav('users')}>
          <strong>{fieldUsedView.toLocaleString()}</strong>
          <span>Field used</span>
        </button>
        <div className="portal-kpi">
          <strong>{districtsView}</strong>
          <span>Districts in data</span>
        </div>
      </div>

      {/* Super Admin: Breakdown by Client Admin (Allocated, Web Reserved, Web Used, Field Used, Remaining) */}
      {isSuper ? (
        <div className="card" style={{ marginBottom: 20, overflowX: 'auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 8 }}>
            <div>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Client Admin Survey &amp; Quota Breakdown</h3>
              <p className="muted" style={{ margin: '2px 0 0', fontSize: 12 }}>
                Record allocation, web quota reserved, and field vs. web intake for every registered Client Admin
              </p>
            </div>
            <button
              type="button"
              className="btn small"
              onClick={() => onNav('admins')}
              style={{ fontSize: 12, padding: '4px 12px' }}
            >
              Manage Client Admins →
            </button>
          </div>

          {loadingBreakdown ? (
            <PortalSkeleton rows={3} label="Loading Client Admin breakdown…" />
          ) : clientBreakdown.length === 0 ? (
            <p className="muted" style={{ fontSize: 13, padding: '12px 0' }}>No Client Admins registered yet.</p>
          ) : (
            <table className="mini-table" style={{ width: '100%', marginTop: 8 }}>
              <thead>
                <tr>
                  <th>Client Admin</th>
                  <th>Company</th>
                  <th style={{ textAlign: 'right' }}>Allocated</th>
                  <th style={{ textAlign: 'right' }}>Allocated for Web</th>
                  <th style={{ textAlign: 'right' }}>Used (Web)</th>
                  <th style={{ textAlign: 'right' }}>Used (Field)</th>
                  <th style={{ textAlign: 'right' }}>Rejected</th>
                  <th style={{ textAlign: 'right' }}>Total Used</th>
                  <th style={{ textAlign: 'right' }}>Remaining for Field</th>
                  <th style={{ textAlign: 'center' }}>Surveys</th>
                </tr>
              </thead>
              <tbody>
                {clientBreakdown.map((ca) => {
                  const isExp = !!expandedAdmins[ca.id]
                  const hasSurveys = Array.isArray(ca.surveys) && ca.surveys.length > 0
                  return (
                    <Fragment key={ca.id}>
                      <tr style={{ background: isExp ? '#f8fafc' : undefined }}>
                        <td>
                          <strong>{ca.name || ca.username}</strong>
                          <span className="muted" style={{ fontSize: 11, display: 'block' }}>@{ca.username}</span>
                        </td>
                        <td>
                          <span style={{ fontSize: 12, fontWeight: 600, color: '#334155' }}>
                            {ca.company_name || '—'}
                          </span>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <strong>{Number(ca.allocated || 0).toLocaleString()}</strong>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <span style={{ color: Number(ca.web_allocated) > 0 ? '#1d4ed8' : '#64748b', fontWeight: 600 }}>
                            {Number(ca.web_allocated) > 0 ? Number(ca.web_allocated).toLocaleString() : '0'}
                          </span>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <span style={{ color: Number(ca.web_used) > 0 ? '#4f7dc6' : '#64748b', fontWeight: 600 }}>
                            {Number(ca.web_used).toLocaleString()}
                          </span>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <strong style={{ color: Number(ca.field_used) > 0 ? '#0f172a' : '#64748b' }}>
                            {Number(ca.field_used).toLocaleString()}
                          </strong>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <span style={{ color: Number(ca.rejected || 0) > 0 ? '#dc2626' : '#64748b', fontWeight: Number(ca.rejected || 0) > 0 ? 700 : 400 }}>
                            {Number(ca.rejected || 0).toLocaleString()}
                          </span>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <strong>{Number(ca.total_used).toLocaleString()}</strong>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {ca.field_remaining != null ? (
                            <span style={{
                              color: Number(ca.field_remaining) === 0 ? '#dc2626' : '#4f7dc6',
                              fontWeight: 700,
                            }}>
                              {Number(ca.field_remaining).toLocaleString()}
                            </span>
                          ) : (
                            <span className="muted">0</span>
                          )}
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          {hasSurveys ? (
                            <button
                              type="button"
                              className="btn small"
                              onClick={() => toggleAdmin(ca.id)}
                              style={{ fontSize: 11, padding: '2px 8px' }}
                            >
                              {ca.surveys.length} {isExp ? '▲ Hide' : '▼ View'}
                            </button>
                          ) : (
                            <span className="muted" style={{ fontSize: 12 }}>0</span>
                          )}
                        </td>
                      </tr>

                      {/* Nested survey list for this client admin */}
                      {isExp && hasSurveys && (
                        <tr>
                          <td colSpan={10} style={{ background: '#f8fafc', padding: '10px 16px 14px' }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: '#475569', marginBottom: 6 }}>
                              Surveys under {ca.name || ca.username} ({ca.company_name || 'No company'}):
                            </div>
                            <table className="mini-table" style={{ width: '100%', background: '#ffffff', borderRadius: 8, border: '1px solid #e2e8f0' }}>
                              <thead>
                                <tr style={{ background: '#f1f5f9' }}>
                                  <th>Survey</th>
                                  <th style={{ textAlign: 'right' }}>Allocated for Web</th>
                                  <th style={{ textAlign: 'right' }}>Used (Web)</th>
                                  <th style={{ textAlign: 'right' }}>Web Remaining</th>
                                  <th style={{ textAlign: 'right' }}>Used (Field)</th>
                                  <th style={{ textAlign: 'right' }}>Pending</th>
                                  <th style={{ textAlign: 'right' }}>Confirmed</th>
                                  <th style={{ textAlign: 'right' }}>Rejected</th>
                                  <th style={{ textAlign: 'right' }}>Total</th>
                                </tr>
                              </thead>
                              <tbody>
                                {ca.surveys.map((sv) => (
                                  <tr key={sv.id || sv.form_key}>
                                    <td>
                                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                        <strong>{sv.title || sv.form_key}</strong>
                                        {sv.is_live && (
                                          <span style={{
                                            display: 'inline-flex', alignItems: 'center', gap: 3,
                                            background: '#dcfce7', color: '#15803d',
                                            fontSize: 10, fontWeight: 700,
                                            padding: '1px 6px', borderRadius: 99,
                                            border: '1px solid #86efac',
                                          }}>
                                            <span style={{
                                              width: 5, height: 5, borderRadius: '50%',
                                              background: '#16a34a',
                                              animation: 'live-pulse 1.4s ease-in-out infinite',
                                              display: 'inline-block',
                                            }} />
                                            LIVE
                                          </span>
                                        )}
                                      </span>
                                    </td>
                                    <td style={{ textAlign: 'right' }}>
                                      {Number(sv.web_allocated) > 0 ? Number(sv.web_allocated).toLocaleString() : '—'}
                                    </td>
                                    <td style={{ textAlign: 'right' }}>
                                      {Number(sv.web_used).toLocaleString()}
                                    </td>
                                    <td style={{ textAlign: 'right' }}>
                                      {sv.web_remaining != null ? (
                                        <span style={{ color: Number(sv.web_remaining) === 0 ? '#dc2626' : '#4f7dc6', fontWeight: 600 }}>
                                          {Number(sv.web_remaining).toLocaleString()} left
                                        </span>
                                      ) : (
                                        <span className="muted">—</span>
                                      )}
                                    </td>
                                    <td style={{ textAlign: 'right' }}>
                                      {Number(sv.field_used).toLocaleString()}
                                    </td>
                                    <td style={{ textAlign: 'right' }}>
                                      {Number(sv.pending || 0).toLocaleString()}
                                    </td>
                                    <td style={{ textAlign: 'right' }}>
                                      {Number(sv.confirmed || 0).toLocaleString()}
                                    </td>
                                    <td style={{ textAlign: 'right', color: Number(sv.rejected || 0) > 0 ? '#dc2626' : '#64748b', fontWeight: Number(sv.rejected || 0) > 0 ? 700 : 400 }}>
                                      {Number(sv.rejected || 0).toLocaleString()}
                                    </td>
                                    <td style={{ textAlign: 'right' }}>
                                      <strong>{Number(sv.total_used || (Number(sv.field_used || 0) + Number(sv.web_used || 0))).toLocaleString()}</strong>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
              <tfoot>
                <tr style={{ background: '#f1f5f9', fontWeight: 700 }}>
                  <td colSpan={2}>
                    <strong>Total across Client Admins</strong>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {clientBreakdown.reduce((sum, ca) => sum + (Number(ca.allocated) || 0), 0).toLocaleString()}
                  </td>
                  <td style={{ textAlign: 'right', color: '#1d4ed8' }}>
                    {clientBreakdown.reduce((sum, ca) => sum + (Number(ca.web_allocated) || 0), 0).toLocaleString()}
                  </td>
                  <td style={{ textAlign: 'right', color: '#4f7dc6' }}>
                    {clientBreakdown.reduce((sum, ca) => sum + (Number(ca.web_used) || 0), 0).toLocaleString()}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {clientBreakdown.reduce((sum, ca) => sum + (Number(ca.field_used) || 0), 0).toLocaleString()}
                  </td>
                  <td style={{ textAlign: 'right', color: '#dc2626' }}>
                    {clientBreakdown.reduce((sum, ca) => sum + (Number(ca.rejected) || 0), 0).toLocaleString()}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {clientBreakdown.reduce((sum, ca) => sum + (Number(ca.total_used) || 0), 0).toLocaleString()}
                  </td>
                  <td style={{ textAlign: 'right', color: '#4f7dc6' }}>
                    {clientBreakdown.reduce((sum, ca) => sum + (Number(ca.field_remaining) || 0), 0).toLocaleString()}
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    {clientBreakdown.reduce((sum, ca) => sum + (Number(ca.survey_count) || 0), 0)}
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      ) : (
        /* Client Admin: Survey breakdown with allocated, allocated for web, remaining for field, rejected */
        surveyBreak.length > 0 && (
          <div className="card" style={{ marginBottom: 20, overflowX: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Survey Breakdown &amp; Quotas</h3>
                <p className="muted" style={{ margin: '2px 0 0', fontSize: 12 }}>
                  Field and web fills per survey · web share turns off when that survey’s target is reached
                </p>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <QuotaLine
                  fieldUsed={Number(fieldUsed) || 0}
                  cap={Number(allotCap) || 0}
                  webReserved={Number(webReserved) || 0}
                />
                <div style={{ padding: '6px 12px', borderRadius: 8, background: rejectedTotal > 0 ? '#fef2f2' : '#f8fafc', border: `1px solid ${rejectedTotal > 0 ? '#fecaca' : '#e2e8f0'}`, textAlign: 'center' }}>
                  <span style={{ fontSize: 11, color: rejectedTotal > 0 ? '#b91c1c' : '#64748b', display: 'block', fontWeight: 600 }}>Rejected</span>
                  <strong style={{ fontSize: 14, color: rejectedTotal > 0 ? '#dc2626' : '#0f172a' }}>{rejectedTotal.toLocaleString()}</strong>
                </div>
              </div>
            </div>
            <table className="mini-table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>Survey</th>
                  <th style={{ textAlign: 'right' }}>Allocated for Web</th>
                  <th style={{ textAlign: 'right' }}>Used (Web)</th>
                  <th style={{ textAlign: 'right' }}>Web Remaining</th>
                  <th style={{ textAlign: 'right' }}>Used (Field)</th>
                  <th style={{ textAlign: 'right' }}>Pending</th>
                  <th style={{ textAlign: 'right' }}>Confirmed</th>
                  <th style={{ textAlign: 'right' }}>Rejected</th>
                  <th style={{ textAlign: 'right' }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {surveyBreak.map((s) => {
                  const link = s.web_link
                  const cap = Number(link?.max_uses) || 0
                  const rawWeb = Number(s.web_submissions) || 0
                  const linkUsed = Number(link?.use_count) || 0
                  const webTotal = Math.max(rawWeb, linkUsed)
                  const left = cap > 0 ? Math.max(0, cap - webTotal) : null
                  const closed = !!link?.expired || (cap > 0 && left === 0)
                  const isLive = !!link?.token && !closed
                  const field = Number(s.field_submissions) || 0
                  const pending = Number(s.pending) || 0
                  const confirmed = Number(s.confirmed) || 0
                  const rejected = Number(s.rejected) || 0
                  const total = pending + confirmed + rejected
                  return (
                    <tr key={s.id || s.form_key}>
                      <td>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <strong>{s.title || s.form_key}</strong>
                          {isLive && (
                            <span style={{
                              display: 'inline-flex', alignItems: 'center', gap: 4,
                              background: '#dcfce7', color: '#15803d',
                              fontSize: 10, fontWeight: 700, letterSpacing: '0.05em',
                              padding: '2px 7px', borderRadius: 99,
                              border: '1px solid #86efac',
                            }}>
                              <span style={{
                                width: 6, height: 6, borderRadius: '50%',
                                background: '#16a34a',
                                animation: 'live-pulse 1.4s ease-in-out infinite',
                                display: 'inline-block',
                              }} />
                              LIVE
                            </span>
                          )}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {cap > 0 ? (
                          <span style={{ fontWeight: 600, color: '#1d4ed8' }}>{cap.toLocaleString()}</span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <span style={{ color: webTotal > 0 ? '#4f7dc6' : '#64748b', fontWeight: 600 }}>{webTotal.toLocaleString()}</span>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {closed ? (
                          <span style={{ color: '#dc2626', fontWeight: 700, fontSize: 12 }}>Disabled · 0 left</span>
                        ) : cap > 0 ? (
                          <span style={{ color: '#4f7dc6', fontWeight: 600, fontSize: 12 }}>
                            {left.toLocaleString()} left
                          </span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <strong>{field.toLocaleString()}</strong>
                      </td>
                      <td style={{ textAlign: 'right' }}>{pending.toLocaleString()}</td>
                      <td style={{ textAlign: 'right' }}>{confirmed.toLocaleString()}</td>
                      <td style={{ textAlign: 'right', color: rejected > 0 ? '#dc2626' : '#64748b', fontWeight: rejected > 0 ? 700 : 400 }}>
                        {rejected.toLocaleString()}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <strong>{total.toLocaleString()}</strong>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                {(() => {
                  const totWebAlloc = surveyBreak.reduce((n, s) => n + (Number(s.web_link?.max_uses) || 0), 0)
                  const totWebUsed = surveyBreak.reduce((n, s) => n + Math.max(Number(s.web_submissions) || 0, Number(s.web_link?.use_count) || 0), 0)
                  const totWebLeft = totWebAlloc > 0 ? Math.max(0, totWebAlloc - totWebUsed) : null
                  const totField = surveyBreak.reduce((n, s) => n + (Number(s.field_submissions) || 0), 0)
                  const totPending = surveyBreak.reduce((n, s) => n + (Number(s.pending) || 0), 0)
                  const totConfirmed = surveyBreak.reduce((n, s) => n + (Number(s.confirmed) || 0), 0)
                  const totRejected = surveyBreak.reduce((n, s) => n + (Number(s.rejected) || 0), 0)
                  const totSubmissions = totPending + totConfirmed + totRejected

                  return (
                    <tr style={{ background: '#f1f5f9', fontWeight: 700 }}>
                      <td>
                        <strong>Total (All Surveys)</strong>
                      </td>
                      <td style={{ textAlign: 'right', color: '#1d4ed8' }}>
                        {totWebAlloc > 0 ? totWebAlloc.toLocaleString() : '0'}
                      </td>
                      <td style={{ textAlign: 'right', color: '#4f7dc6' }}>
                        {totWebUsed.toLocaleString()}
                      </td>
                      <td style={{ textAlign: 'right', color: '#4f7dc6' }}>
                        {totWebLeft != null ? `${totWebLeft.toLocaleString()} left` : '—'}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {totField.toLocaleString()}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {totPending.toLocaleString()}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {totConfirmed.toLocaleString()}
                      </td>
                      <td style={{ textAlign: 'right', color: totRejected > 0 ? '#dc2626' : '#64748b' }}>
                        {totRejected.toLocaleString()}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <strong>{totSubmissions.toLocaleString()}</strong>
                      </td>
                    </tr>
                  )
                })()}
              </tfoot>
            </table>

            <div style={{ marginTop: 10, padding: '8px 12px', background: '#f8fafc', borderRadius: 8, border: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, fontSize: 12 }}>
              <span className="muted">
                Total Allocated: <strong>{allotCap.toLocaleString()}</strong> · Web Reserved: <strong>{webReserved.toLocaleString()}</strong> · Field Used: <strong>{fieldUsedView.toLocaleString()}</strong> · Rejected: <strong style={{ color: rejectedCount > 0 ? '#dc2626' : undefined }}>{rejectedCount.toLocaleString()}</strong>
              </span>
              <span style={{ color: '#3f6cbe', fontWeight: 700 }}>
                Remaining for Field: {fieldLeft != null ? fieldLeft.toLocaleString() : '0'} records
              </span>
            </div>
          </div>
        )
      )}

      {/* Mixed Live Intake & Activity Stream — Mock 3 doctrine */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 6 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Live Activity &amp; Intake Stream</h3>
            <p className="csub" style={{ margin: '2px 0 0', fontSize: 12, color: '#64748b' }}>
              Real-time submission flow · Pending review, Confirmed &amp; Rejected
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 4, background: '#f1f5f9', padding: 3, borderRadius: 8 }}>
              <button
                type="button"
                onClick={() => setActivityFilter('all')}
                style={{
                  border: 0,
                  background: activityFilter === 'all' ? '#ffffff' : 'transparent',
                  color: activityFilter === 'all' ? '#0f172a' : '#64748b',
                  fontWeight: activityFilter === 'all' ? 700 : 500,
                  fontSize: 11,
                  padding: '4px 10px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  boxShadow: activityFilter === 'all' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                }}
              >
                All ({liveAllCount})
              </button>
              <button
                type="button"
                onClick={() => setActivityFilter('web')}
                style={{
                  border: 0,
                  background: activityFilter === 'web' ? '#ffffff' : 'transparent',
                  color: activityFilter === 'web' ? '#1d4ed8' : '#64748b',
                  fontWeight: activityFilter === 'web' ? 700 : 500,
                  fontSize: 11,
                  padding: '4px 10px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  boxShadow: activityFilter === 'web' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                }}
              >
                Web ({liveWebCount || webSubmitted})
              </button>
              <button
                type="button"
                onClick={() => setActivityFilter('pending')}
                style={{
                  border: 0,
                  background: activityFilter === 'pending' ? '#ffffff' : 'transparent',
                  color: activityFilter === 'pending' ? '#d97706' : '#64748b',
                  fontWeight: activityFilter === 'pending' ? 700 : 500,
                  fontSize: 11,
                  padding: '4px 10px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  boxShadow: activityFilter === 'pending' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                }}
              >
                Pending ({pendingCount})
              </button>
              <button
                type="button"
                onClick={() => setActivityFilter('confirmed')}
                style={{
                  border: 0,
                  background: activityFilter === 'confirmed' ? '#ffffff' : 'transparent',
                  color: activityFilter === 'confirmed' ? '#16a34a' : '#64748b',
                  fontWeight: activityFilter === 'confirmed' ? 700 : 500,
                  fontSize: 11,
                  padding: '4px 10px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  boxShadow: activityFilter === 'confirmed' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                }}
              >
                Confirmed ({confirmedCount})
              </button>
              <button
                type="button"
                onClick={() => setActivityFilter('rejected')}
                style={{
                  border: 0,
                  background: activityFilter === 'rejected' ? '#ffffff' : 'transparent',
                  color: activityFilter === 'rejected' ? '#ef4444' : '#64748b',
                  fontWeight: activityFilter === 'rejected' ? 700 : 500,
                  fontSize: 11,
                  padding: '4px 10px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  boxShadow: activityFilter === 'rejected' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                }}
              >
                Rejected ({rejectedCount})
              </button>
            </div>
            {gated('review') && (
              <button
                type="button"
                className="btn small"
                onClick={() => onNav('review')}
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: '#4f7dc6',
                  background: '#eff6ff',
                  border: '1px solid #bfdbfe',
                  borderRadius: 6,
                  padding: '5px 12px',
                  cursor: 'pointer',
                }}
              >
                Open Review →
              </button>
            )}
          </div>
        </div>

        {loadingRecent ? (
          <PortalSkeleton rows={3} label="Loading live stream…" />
        ) : displayedItems.length === 0 ? (
          <p className="muted" style={{ fontSize: 13, margin: '14px 0 8px' }}>No submissions matching this filter.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
            {displayedItems.map((it) => {
              const a = it.answers || {}
              const isWeb = it.source === 'web-survey' || it.source === 'web'
              const surveyor = it.submitted_by || a.data_collector || (isWeb ? 'Web survey' : 'Field Surveyor')
              const district = a.district || a.constituency || (isWeb ? 'Web' : 'General')
              const respondent = a.respondent_name || a.name || (isWeb ? 'Web respondent' : 'Respondent')
              const status = it.status || 'pending'
              const timeStr = it.created_at ? new Date(it.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '9:32 AM'

              return (
                <div
                  key={it.id}
                  onClick={() =>
                    onNav({
                      page: 'review',
                      submissionId: it.id,
                      source: isWeb ? 'web' : 'field',
                      formKey: it.form_key || it.form_id || '',
                    })
                  }
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    padding: '12px 16px',
                    background: status === 'pending' ? '#ffffff' : '#f8fafc',
                    border: `1px solid ${status === 'pending' ? '#e2e8f0' : '#e2e8f0'}`,
                    borderLeft: `3px solid ${status === 'confirmed' ? '#16a34a' : status === 'rejected' ? '#ef4444' : '#f59e0b'}`,
                    borderRadius: 10,
                    cursor: 'pointer',
                    transition: 'all 120ms ease',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', fontFamily: 'monospace' }}>
                      #{it.record_index || it.id}
                    </span>
                    <span style={{ fontSize: 13, color: '#334155', fontWeight: 500 }}>
                      {district} · {respondent} · {timeStr} · <span style={{ color: '#64748b' }}>by {surveyor}</span>
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                    {isWeb ? (
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          padding: '3px 10px',
                          borderRadius: 6,
                          background: '#eff6ff',
                          color: '#1d4ed8',
                        }}
                      >
                        Web
                      </span>
                    ) : null}
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        padding: '3px 10px',
                        borderRadius: 6,
                        background: status === 'confirmed' ? '#f0fdf4' : status === 'rejected' ? '#fef2f2' : '#fffbeb',
                        color: status === 'confirmed' ? '#16a34a' : status === 'rejected' ? '#ef4444' : '#f59e0b',
                        textTransform: 'capitalize',
                      }}
                    >
                      {status}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        onNav({
                          page: 'review',
                          submissionId: it.id,
                          source: isWeb ? 'web' : 'field',
                          formKey: it.form_key || it.form_id || '',
                        })
                      }}
                      style={{
                        border: '1px solid #bfdbfe',
                        background: status === 'pending' ? '#eff6ff' : '#ffffff',
                        color: '#4f7dc6',
                        fontSize: 12,
                        fontWeight: 600,
                        borderRadius: 6,
                        padding: '4px 10px',
                        cursor: 'pointer',
                      }}
                    >
                      {status === 'pending' ? 'Open Review' : 'Inspect'}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>


      {/* My Allocation for Client Admin / Platform Governance Quick Actions for Super Admin */}
      {isSuper ? (
        <div className="card" style={{ marginBottom: 20 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Platform Governance Quick Actions</h3>
          <p className="csub" style={{ margin: '2px 0 14px', fontSize: 12, color: '#64748b' }}>
            Multi-tenant control, power delegation, audit trails, and projects
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
            <button
              type="button"
              className="portal-action"
              onClick={() => onNav('companies')}
              style={{ padding: '12px 14px', borderRadius: 10, border: '1px solid #e2e8f0', background: '#ffffff', cursor: 'pointer', textAlign: 'left' }}
            >
              <span style={{ fontSize: 16, display: 'block', marginBottom: 4 }}>🏢</span>
              <strong style={{ fontSize: 13, display: 'block', color: '#0f172a' }}>Companies</strong>
              <span style={{ fontSize: 11, color: '#64748b' }}>Manage organizations &amp; projects</span>
            </button>
            <button
              type="button"
              className="portal-action"
              onClick={() => onNav('admins')}
              style={{ padding: '12px 14px', borderRadius: 10, border: '1px solid #e2e8f0', background: '#ffffff', cursor: 'pointer', textAlign: 'left' }}
            >
              <span style={{ fontSize: 16, display: 'block', marginBottom: 4 }}>🛡️</span>
              <strong style={{ fontSize: 13, display: 'block', color: '#0f172a' }}>Client Admins</strong>
              <span style={{ fontSize: 11, color: '#64748b' }}>Power delegation &amp; accounts</span>
            </button>
            <button
              type="button"
              className="portal-action"
              onClick={() => onNav('surveys')}
              style={{ padding: '12px 14px', borderRadius: 10, border: '1px solid #e2e8f0', background: '#ffffff', cursor: 'pointer', textAlign: 'left' }}
            >
              <span style={{ fontSize: 16, display: 'block', marginBottom: 4 }}>📋</span>
              <strong style={{ fontSize: 13, display: 'block', color: '#0f172a' }}>Projects</strong>
              <span style={{ fontSize: 11, color: '#64748b' }}>Questions &amp; assignments</span>
            </button>
            <button
              type="button"
              className="portal-action"
              onClick={() => onNav('audit')}
              style={{ padding: '12px 14px', borderRadius: 10, border: '1px solid #e2e8f0', background: '#ffffff', cursor: 'pointer', textAlign: 'left' }}
            >
              <span style={{ fontSize: 16, display: 'block', marginBottom: 4 }}>⭐</span>
              <strong style={{ fontSize: 13, display: 'block', color: '#0f172a' }}>Platform Audit</strong>
              <span style={{ fontSize: 11, color: '#64748b' }}>Platform activity log &amp; quotas</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="card" style={{ marginBottom: 20 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>My allocation</h3>
          <p className="csub" style={{ margin: '2px 0 14px', fontSize: 12, color: '#64748b' }}>
            Records &amp; features granted by Super Admin
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <span className="chip" style={{ background: '#f1f5f9', border: '1px solid #e2e8f0', color: '#1e293b', fontSize: 12, fontWeight: 600 }}>
              Surveys <strong>{surveyBreak.length || Number(stats?.surveys_count) || 0} / {Number(user?.max_surveys || 0)}</strong>
            </span>
            <span className="chip" style={{ background: '#f1f5f9', border: '1px solid #e2e8f0', color: '#1e293b', fontSize: 12, fontWeight: 600 }}>
              Surveyors <strong>{surveyorCount || Number(stats?.surveyors_count) || 0} / {Number(user?.max_surveyors || 0)}</strong>
            </span>
            <span className="chip" style={{ background: '#f1f5f9', border: '1px solid #e2e8f0', color: '#1e293b', fontSize: 12, fontWeight: 600 }}>
              Total survey questions created <strong>{totalQuestionsUsed} / Allotted {Number(user?.max_questions_per_survey || 0)}</strong>
            </span>
            <span className="chip" style={{ background: '#f0fdf4', border: '1px solid #dcfce7', color: '#16a34a', fontSize: 12, fontWeight: 600 }}>
              Confirmed <strong>{confirmedTotal.toLocaleString()}</strong>
            </span>
            <span className="chip" style={{ background: '#fef2f2', border: '1px solid #fee2e2', color: '#ef4444', fontSize: 12, fontWeight: 600 }}>
              Rejected <strong>{rejectedTotal.toLocaleString()}</strong>
            </span>
            <span className="chip" style={{ background: '#f1f5f9', border: '1px solid #e2e8f0', color: '#1e293b', fontSize: 12, fontWeight: 600 }}>
              Records <strong>{allSubmitted.toLocaleString()} / {allotCap.toLocaleString()}</strong>
            </span>
          </div>
        </div>
      )}

    </div>
  )
}

export default function AdminPortal({ superAdminOnly = false }) {
  // Live APK release — sidebar download link follows the Cloudflare mirror.
  const appRelease = useAppRelease()
  const [user, setUser] = useState(() => {
    const u = getStoredUser()
    return u &&
      (superAdminOnly
        ? u.role === 'super_admin'
        : u.role === 'admin' || u.role === 'super_admin')
      ? u
      : null
  })
  const [authReady, setAuthReady] = useState(false)
  const [page, setPage] = useState('overview')
  const [stats, setStats] = useState(null)
  const [surveys, setSurveys] = useState([])
  const [toast, setToast] = useState(null)
  const [navOpen, setNavOpen] = useState(false)
  const [deepLink, setDeepLink] = useState(null)

  const isSuper = superAdminOnly || user?.role === 'super_admin'
  // Desktop dock vs mobile topbar render the same controls; mount only one bell
  // so we don't open two notification streams to the API.
  const isNarrow = useIsNarrow(960)

  const canPage = useCallback(
    (p) => {
      if (isSuper) return p !== 'subadmins' // Super manages sub-admin seats via Client Admins
      if (user?.role === 'sub_client_admin' && p === 'subadmins') return false // only the Client Admin manages sub admins
      if (['clients', 'inbox', 'logs', 'companies', 'admins', 'seats', 'audit', 'contact', 'errors'].includes(p)) return false
      const need = PAGE_POWER[p]
      if (!need) return true
      const needs = Array.isArray(need) ? need : [need]
      return needs.some((k) => {
        const val = user?.[k]
        return val === true || val === 'true' || val === 't' || val === 1
      })
    },
    [isSuper, user]
  )

  const baseNav = isSuper
    ? [...NAV, CLIENTS_NAV, INBOX_NAV, LOGS_NAV]
    : NAV
  const nav = baseNav
    .map((n) => ({ ...n, pages: n.pages.filter(canPage) }))
    .filter((n) => n.pages.length > 0)

  const toastTimer = useRef(0)
  const notify = useCallback((message, type = 'ok') => {
    setToast({ message, type })
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 3200)
  }, [])
  useEffect(() => () => window.clearTimeout(toastTimer.current), [])

  const goPage = useCallback((p, extra = null) => {
    const src = typeof p === 'string' ? { page: p } : p && typeof p === 'object' ? p : null
    if (src?.page && LEGACY_PAGE[src.page]) src.page = LEGACY_PAGE[src.page]
    const raw = src?.page
    const pageId = raw && PAGE_LABELS[raw] ? raw : null
    if (!pageId) {
      notify('Could not open that notification', 'error')
      return
    }
    if (!canPage(pageId)) {
      const power = PAGE_POWER[pageId]
      notify(
        power
          ? `🔒 Ask your Client Admin to grant you: ${PAGE_LABELS[pageId] || pageId}`
          : 'You do not have access to that page',
        'error',
      )
      setPage('overview')
      setDeepLink(null)
      setNavOpen(false)
      return
    }
    setPage(pageId)
    setNavOpen(false)
    const userId = src.userId ?? extra?.userId ?? null
    const submissionId = src.submissionId ?? extra?.submissionId ?? null
    const source = src.source ?? extra?.source ?? null
    const formKey = src.formKey ?? src.form_key ?? extra?.formKey ?? extra?.form_key ?? null
    if (userId != null || submissionId != null || source != null || formKey != null) {
      setDeepLink({ page: pageId, userId, submissionId, source, formKey })
    } else if (extra) {
      setDeepLink({ page: pageId, ...extra })
    } else {
      setDeepLink(null)
    }
  }, [canPage, notify])

  const handleLogout = useCallback(async () => {
    try {
      localStorage.removeItem(`esurvey_last_active_${String(user?.id ?? 'anon')}`)
      localStorage.removeItem('esurvey_idle_logged_out')
    } catch {
      /* ignore */
    }
    await logout()
    setUser(null)
    setStats(null)
    setSurveys([])
    setPage('overview')
    notify('Logged out', 'ok')
  }, [notify])

  const handleIdleLogout = useCallback(async () => {
    try {
      localStorage.setItem('esurvey_idle_logged_out', String(Date.now()))
      // Drop the stale per-account stamp so the next login starts a fresh window
      localStorage.removeItem(`esurvey_last_active_${String(user?.id ?? 'anon')}`)
    } catch {
      /* ignore */
    }
    await logout()
    setUser(null)
    setStats(null)
    setSurveys([])
    setPage('overview')
    notify('Logged out due to 30 minutes of inactivity', 'error')
  }, [notify])

  const inboxCounts = useInboxCounts()
  const inboxBadge = (inboxCounts.contacts || 0) + (inboxCounts.seats || 0)
  useEffect(() => {
    if (!isSuper || !authReady) return undefined
    void fetchInboxCounts()
    const t = setInterval(() => { void fetchInboxCounts() }, 60_000)
    return () => clearInterval(t)
  }, [isSuper, authReady])

  useIdleTimeout({
    onTimeout: handleIdleLogout,
    timeoutMs: 30 * 60 * 1000,
    enabled: Boolean(user && authReady),
    storageKey: `esurvey_last_active_${String(user?.id ?? 'anon')}`,
  })

  useEffect(() => {
    const onUnauthorized = (e) => {
      clearSession()
      setUser(null)
      setStats(null)
        setSurveys([])
      setPage('overview')
      const msg = e?.detail?.error || 'Account updated or session expired — please sign in again'
      notify(msg, 'error')
    }
    window.addEventListener('esurvey-unauthorized', onUnauthorized)
    return () => window.removeEventListener('esurvey-unauthorized', onUnauthorized)
  }, [notify])

  /** Lightweight overview KPIs only — not full submissions */
  const [quotaSurveys, setQuotaSurveys] = useState([])

  // getStats() can come back zeroed while the per-survey counts (listSurveys) are right.
  // Take the larger of the two so KPIs, quota and the setup checklist agree with the
  // Survey Breakdown table. Raw `stats` stays untouched for refresh logic.
  const effectiveStats = useMemo(() => {
    if (!stats) return stats
    const sv = quotaSurveys.reduce(
      (a, sv0) => ({
        pending: a.pending + (Number(sv0.pending) || 0),
        confirmed: a.confirmed + (Number(sv0.confirmed) || 0),
        rejected: a.rejected + (Number(sv0.rejected) || 0),
        field: a.field + (Number(sv0.field_submissions) || 0),
      }),
      { pending: 0, confirmed: 0, rejected: 0, field: 0 },
    )
    const top = (k, v) => Math.max(Number(stats[k]) || 0, v)
    return {
      ...stats,
      pending: top('pending', sv.pending),
      confirmed: top('confirmed', sv.confirmed),
      rejected: top('rejected', sv.rejected),
      submissions: top('submissions', sv.pending + sv.confirmed + sv.rejected),
      field_submissions: top('field_submissions', sv.field),
      field_used: top('field_used', sv.field),
    }
  }, [stats, quotaSurveys])
  const loadStats = useCallback(async () => {
    if (!getToken()) return
    try {
      const [st, surveyData] = await Promise.all([
        getStats(),
        listSurveys().catch(() => null),
      ])
      setStats(st)
      if (surveyData?.items) {
        setQuotaSurveys(
          (surveyData.items || []).filter(
            (s) => s.form_key !== 'default' && s.form_key !== 'legacy',
          ),
        )
      }
    } catch {
      /* ignore */
    }
  }, [])

  /** Manual refresh: stats + session */
  const [loadingData, setLoadingData] = useState(false)
  const loadPortal = useCallback(async () => {
    if (!getToken()) return
    setLoadingData(true)
    try {
      const meRes = await me().catch(() => null)
      if (meRes?.user) setUser(meRes.user)
      await loadStats()
      notify('Portal data refreshed ✓', 'ok')
    } catch (e) {
      if (e.status === 401) {
        await handleLogout()
        return
      }
      notify(e.message || 'Refresh failed', 'error')
    } finally {
      setLoadingData(false)
    }
  }, [loadStats, notify, handleLogout])

  useEffect(() => {
    let cancelled = false
    const timeout = setTimeout(() => {
      if (!cancelled) {
        setUser(null)
        setAuthReady(true)
      }
    }, 4000)

    ;(async () => {
      if (!getToken()) {
        clearTimeout(timeout)
        if (!cancelled) {
          setUser(null)
          setAuthReady(true)
        }
        return
      }
      try {
        const data = await me()
        const okRole = superAdminOnly
          ? data.user?.role === 'super_admin'
          : data.user?.role === 'admin' || data.user?.role === 'super_admin' || data.user?.role === 'sub_client_admin'
        if (!okRole) {
          await logout()
          if (!cancelled) {
            setUser(null)
            setAuthReady(true)
          }
          return
        }
        if (!cancelled) {
          setUser(data.user)
          setAuthReady(true)
        }
      } catch (e) {
        if (!cancelled) {
          setUser(null)
          setAuthReady(true)
          // A transient me() failure (offline, cold start, aborted boot) must
          // NOT delete the server session — that logged people out for good.
          // Only a real 401 means the session is gone; even then the server
          // already knows, so local cleanup is enough.
          if (e?.status === 401) {
            clearSession()
          } else {
            notify('Could not reach the server — check the connection and retry', 'error')
          }
        }
      } finally {
        clearTimeout(timeout)
      }
    })()
    return () => {
      cancelled = true
      clearTimeout(timeout)
    }
  }, [])

  // Overview: stats only (cheap) — auto-refresh so field completions show up
  useEffect(() => {
    if (user && authReady && (page === 'overview' || !stats)) {
      void loadStats()
    }
  }, [user, authReady, page, loadStats]) // eslint-disable-line react-hooks/exhaustive-deps -- load stats on login + overview

  useEffect(() => {
    if (!user || !authReady || page !== 'overview') return undefined
    const tick = () => {
      if (document.visibilityState !== 'visible') return
      void loadStats()
    }
    const id = setInterval(tick, 25_000)
    const onVis = () => {
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [user, authReady, page, loadStats])

  // Real-time synchronization of user powers & quotas (e.g., when Super Admin grants Web survey)
  useEffect(() => {
    if (!user || !authReady) return
    const refreshUser = () => {
      if (!getToken() || document.visibilityState !== 'visible') return
      me()
        .then((data) => {
          if (data?.user) {
            setUser((prev) => ({ ...prev, ...data.user }))
          }
        })
        .catch((e) => console.warn('[portal] profile refresh failed', e))
    }
    window.addEventListener('focus', refreshUser)
    const interval = setInterval(refreshUser, 15_000)
    return () => {
      window.removeEventListener('focus', refreshUser)
      clearInterval(interval)
    }
  }, [user?.id, authReady])

  // Surveys list only when a page needs the dropdown
  useEffect(() => {
    if (!user || !authReady) return
    if (!['data', 'upload', 'review'].includes(page)) return
    if (surveys.length) return
    listSurveys()
      .then((d) => {
        setSurveys(d.items || [])
      })
      .catch((e) => console.warn('[portal] survey list failed', e))
  }, [user, authReady, page, surveys.length])

  if (!authReady) {
    return (
      <div className="portal-shell">
        <div className="portal-login">
          <div className="portal-login-card" style={{ textAlign: 'center' }}>
            <p className="eyebrow">{superAdminOnly ? 'Super Admin Console' : 'Client Admin'}</p>
            <h1 style={{ fontSize: 22 }}>Starting…</h1>
          </div>
        </div>
      </div>
    )
  }

  if (!user) {
    return (
      <div className="portal-shell">
        {toast && (
          <div className={`toast ${toast.type}`} role="status">
            {toast.message}
          </div>
        )}
        <AdminLogin
          superAdminOnly={superAdminOnly}
          onToast={notify}
          onSuccess={(u) => {
            try {
              localStorage.removeItem('esurvey_idle_logged_out')
              // Fresh login → fresh 30-minute idle window for THIS account
              localStorage.setItem(`esurvey_last_active_${String(u?.id ?? 'anon')}`, String(Date.now()))
            } catch {
              /* ignore */
            }
            setUser(u)
            setPage('overview')
          }}
        />
      </div>
    )
  }

  const activeNavLabel =
    nav.find((n) => n.pages.includes(page))?.label || PAGE_LABELS[page] || 'Admin'

  return (
    <div className={`portal-shell${navOpen ? ' nav-open' : ''}`}>
      {toast && (
        <div className={`toast portal-toast ${toast.type}`} role="status">
          {toast.message}
        </div>
      )}

      <div className="admin-bell-dock" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {user?.role === 'admin' ? (
          <QuotaIndicator user={user} stats={effectiveStats} surveys={quotaSurveys} />
        ) : null}
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 12px', borderRadius: 9999, background: '#f0fdf4', border: '1px solid #dcfce7', color: '#16a34a', fontSize: 12, fontWeight: 700 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#16a34a' }}></span>
          Synced just now
        </div>

        <AdminBell user={user} onGoPage={goPage} enabled={!isNarrow} />
      </div>


      <header className="portal-topbar">
        <button
          type="button"
          className="portal-menu-btn"
          aria-label={navOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={navOpen}
          onClick={() => setNavOpen((o) => !o)}
        >
          {navOpen ? <Icon name="cross" size={18} /> : <Icon name="menu" size={18} />}
        </button>
        <div className="portal-topbar-brand">
          <strong>Smart Survey X</strong>
          <span>{PAGE_LABELS[page] || activeNavLabel}</span>
        </div>
        <div className="portal-topbar-actions">
          <button
            type="button"
            className="btn small portal-refresh-pill"
            onClick={() => void loadPortal()}
            title="Refresh"
          >
            ↻
          </button>
          <AdminBell user={user} onGoPage={goPage} enabled={isNarrow} />
        </div>
      </header>

      {navOpen ? (
        <button
          type="button"
          className="portal-drawer-backdrop"
          aria-label="Close menu"
          onClick={() => setNavOpen(false)}
        />
      ) : null}

      <aside className="portal-sidebar" aria-label="Main navigation">
        <div className="side-brand">
          <img className="side-brand-logo" src={logoMark} alt="" /> Smart Survey X
          <span className="role-tag">{isSuper ? 'Super Admin' : user?.role === 'sub_client_admin' ? 'Sub Admin' : 'Client Admin'}</span>
        </div>
        <nav className="portal-nav">
          <div className="side-section-label">MONITORING</div>
          <button className={`side-sub ${page === 'overview' ? 'active' : ''}`} onClick={() => goPage('overview')}><Icon name="grid" size={18} />Dashboard</button>
          <button className={`side-sub ${['analyze', 'explore', 'data'].includes(page) ? 'active' : ''}`} onClick={() => goPage('analyze')}><Icon name="chartUp" size={18} />Analyze &amp; Export</button>
          <button className={`side-sub ${page === 'review' ? 'active' : ''}`} onClick={() => goPage('review')}><Icon name="clipboardCheck" size={18} />Review QA</button>
          <button
            className={`side-sub ${page === 'conversations' ? 'active' : ''}`}
            style={!canPage('conversations') ? { opacity: 0.45 } : undefined}
            title={!canPage('conversations') ? 'Ask your Client Admin to grant you: Conversations' : undefined}
            onClick={() => goPage('conversations')}
          ><Icon name="mic" size={18} />Conversations</button>

          <div className="side-section-label" style={{ marginTop: 14 }}>SETUP &amp; TEAM</div>
          <button className={`side-sub ${page === 'users' ? 'active' : ''}`} onClick={() => goPage('users')}><Icon name="users" size={18} />Surveyors &amp; Quotas</button>
          {user?.role === 'admin' && (
            <button className={`side-sub ${page === 'subadmins' ? 'active' : ''}`} onClick={() => goPage('subadmins')}><Icon name="shield" size={18} />Sub Admins</button>
          )}
          <button className={`side-sub ${['surveys', 'questions', 'bank'].includes(page) ? 'active' : ''}`} onClick={() => goPage('surveys')}><Icon name="clipboard" size={18} />Surveys &amp; Forms</button>
          <button
            className={`side-sub ${page === 'web' ? 'active' : ''}`}
            style={!canPage('web') ? { opacity: 0.45 } : undefined}
            title={!canPage('web') ? 'Ask your Client Admin to grant you: Web survey' : undefined}
            onClick={() => goPage('web')}
          ><Icon name="globe" size={18} />Web survey</button>
          <button className={`side-sub ${page === 'profile' ? 'active' : ''}`} onClick={() => goPage('profile')}><Icon name="building" size={18} />Organization</button>

          {isSuper && (
            <>
              <div className="side-section-label" style={{ marginTop: 14 }}>GOVERNANCE</div>
              <button className={`side-sub ${page === 'clients' || page === 'companies' || page === 'admins' ? 'active' : ''}`} onClick={() => goPage('clients')}><Icon name="shield" size={18} />Clients</button>
              <button
                className={`side-sub ${page === 'inbox' || page === 'contact' || page === 'seats' ? 'active' : ''}`}
                onClick={() => goPage('inbox')}
              ><Icon name="phone" size={18} />Inbox{inboxBadge > 0 ? ` · ${inboxBadge}` : ''}</button>
              <button className={`side-sub ${page === 'logs' || page === 'errors' || page === 'audit' ? 'active' : ''}`} onClick={() => goPage('logs')}><Icon name="lock" size={18} />Logs</button>
            </>
          )}
        </nav>



        <div className="portal-sidebar-foot">
          <button
            type="button"
            className="btn small"
            style={{
              width: '100%',
              marginBottom: 10,
              fontWeight: 'bold',
              background: '#e2e8f0',
              border: '1px solid #cbd5e1',
              color: '#4f7dc6',
              padding: '8px 12px',
              borderRadius: 8,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
            }}
            onClick={() => void loadPortal()}
            disabled={loadingData}
          >
            <Icon
              name="refresh"
              size={14}
              style={loadingData ? { animation: 'spin 1s linear infinite' } : undefined}
            />
            {loadingData ? 'Refreshing…' : 'Refresh Data'}
          </button>
          <button
            type="button"
            className="portal-user"
            onClick={() => (user.role === 'super_admin' ? goPage('profile') : undefined)}
            disabled={user.role !== 'super_admin'}
            title={user.role === 'super_admin' ? 'Open Super Admin profile' : undefined}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              background: 'none',
              border: 0,
              padding: 0,
              cursor: user.role === 'super_admin' ? 'pointer' : 'default',
            }}
          >
            <strong>
              {user.name || user.username}{' '}
              {user.verified ? <VerifiedBadge size={16} title="Verified" /> : null}
              {user.role === 'super_admin' ? <Icon name="star" size={13} /> : ''}
            </strong>
            <span>
              @{user.username} · {user.role === 'super_admin' ? 'Super Admin' : 'Client Admin'}
              {user.role === 'super_admin' ? ' · Profile' : ''}
            </span>
          </button>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '4px 0 8px' }}>
            <a className="portal-link" href={fieldAppUrl()} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }} title="Open surveyor app / PWA in browser">
              <Icon name="smartphone" size={14} />PWA App ↗
            </a>
            <a className="portal-link" href={appRelease?.apkUrl || apkDownloadUrl()} target="_blank" rel="noreferrer" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }} title={`Download Android APK${appRelease ? ` v${appRelease.version}` : ''} (Cloudflare CDN)`}>
              <Icon name="download" size={14} />Download APK{appRelease ? ` · v${appRelease.version}` : ''} ↗
            </a>
          </div>
          <button type="button" className="btn small danger" onClick={handleLogout}>
            Log out
          </button>
        </div>
      </aside>

      <main className="portal-main">
        {nav.filter((n) => {
          const full = (baseNav.find((b) => b.id === n.id)?.pages) || n.pages
          return full.length > 1 && (n.pages.includes(page) || full.includes(page))
        }).map((n) => {
          const full = (baseNav.find((b) => b.id === n.id)?.pages) || n.pages
          return (
            <div className="portal-subtabs" key={n.id}>
              {full.map((p) => {
                const allowed = canPage(p)
                return (
                  <button
                    key={p}
                    type="button"
                    className={page === p ? 'portal-subtab active' : 'portal-subtab'}
                    style={!allowed ? { opacity: 0.45 } : undefined}
                    title={!allowed ? 'Ask your Client Admin to grant you: ' + (PAGE_LABELS[p] || p) : undefined}
                    onClick={() => goPage(p)}
                  >
                    {!allowed ? '🔒 ' : ''}{PAGE_LABELS[p]}
                  </button>
                )
              })}
            </div>
          )
        })}
        <Suspense fallback={<PortalSkeleton rows={6} label="Loading screen…" />}>
          <ChunkErrorBoundary>
          {(page === 'overview' || !canPage(page) || !PAGE_LABELS[page]) && (
            <Overview
              user={user}
              stats={effectiveStats}
              onNav={goPage}
              superAdminOnly={isSuper}
              canPage={canPage}
              onToast={notify}
            />
          )}
          {page === 'users' && canPage('users') && (
            <AdminUsersScreen
              onToast={notify}
              user={user}
              focusUserId={deepLink?.page === 'users' ? deepLink.userId : null}
              onFocusConsumed={() => setDeepLink(null)}
            />
          )}
          {page === 'surveys' && canPage('surveys') && (
            <AdminSurveysScreen onToast={notify} user={user} />
          )}
          {page === 'questions' && canPage('questions') && (
            <AdminQuestionsScreen onToast={notify} user={user} />
          )}
          {/* Report = tables/boards (AdminAnalyze); Analyze = charts/maps (Dashboard) */}
          {(page === 'explore' || page === 'charts' || page === 'report') && canPage(page) && (
            <AdminExploreScreen initialMode={page === 'report' ? 'live' : 'charts'} onToast={notify} />
          )}
          {page === 'analyze' && canPage('analyze') && <DashboardScreen onToast={notify} />}
          {page === 'review' && canPage('review') && (
            <ReviewQAScreen
              onToast={notify}
              user={user}
              focusSubmissionId={deepLink?.page === 'review' ? deepLink.submissionId : null}
              focusSource={deepLink?.page === 'review' ? deepLink.source : null}
              focusFormKey={deepLink?.page === 'review' ? deepLink.formKey : null}
              onFocusConsumed={() => setDeepLink(null)}
            />
          )}
          {(page === 'upload' || page === 'data') && canPage(page) && (
            <AdminDataScreen onToast={notify} initialTab={page === 'upload' ? 'export' : 'raw'} />
          )}
          {page === 'conversations' && canPage('conversations') && (
            <AdminConversationsScreen onToast={notify} />
          )}
          {page === 'bank' && canPage('bank') && (
            <AdminQuestionBankScreen onToast={notify} user={user} onNav={goPage} />
          )}
          {page === 'web' && canPage('web') && (
            <AdminWebSurveyScreen onToast={notify} user={user} />
          )}
          {page === 'profile' && canPage('profile') && (
            <AdminProfileScreen
              user={user}
              onToast={notify}
              onUserUpdated={(u) => setUser((prev) => ({ ...prev, ...u }))}
            />
          )}
          {page === 'subadmins' && canPage('subadmins') && (
            <AdminSubAdminsScreen onToast={notify} />
          )}
          {['clients', 'admins', 'companies'].includes(page) && canPage(page) && (
            <AdminClientsScreen onToast={notify} user={user} />
          )}
          {['inbox', 'contact', 'seats'].includes(page) && canPage(page) && (
            <AdminInboxScreen onToast={notify} />
          )}
          {['logs', 'errors', 'audit'].includes(page) && canPage(page) && (
            <AdminLogsScreen onToast={notify} />
          )}

          </ChunkErrorBoundary>
        </Suspense>
      </main>

      {/* ── Modern Mobile Bottom Navigation Bar (Thumb reachable) ── */}
      <nav className="portal-bottom-nav" aria-label="Mobile Navigation">
        <button
          type="button"
          className={`portal-tab-btn ${page === 'overview' ? 'active' : ''}`}
          onClick={() => goPage('overview')}
        >
          <span className="portal-tab-icon"><Icon name="grid" size={22} /></span>
          <span className="portal-tab-label">Overview</span>
        </button>

        <button
          type="button"
          className={`portal-tab-btn ${['surveys', 'questions', 'bank', 'web'].includes(page) ? 'active' : ''}`}
          onClick={() => goPage('surveys')}
        >
          <span className="portal-tab-icon"><Icon name="clipboard" size={22} /></span>
          <span className="portal-tab-label">Surveys</span>
        </button>

        <button
          type="button"
          className={`portal-tab-btn ${['analyze', 'explore', 'data'].includes(page) ? 'active' : ''}`}
          onClick={() => goPage('analyze')}
        >
          <span className="portal-tab-icon"><Icon name="chartUp" size={22} /></span>
          <span className="portal-tab-label">Analytics</span>
        </button>

        <button
          type="button"
          className={`portal-tab-btn ${['review', 'conversations'].includes(page) ? 'active' : ''}`}
          onClick={() => goPage('review')}
        >
          <span className="portal-tab-icon" style={{ position: 'relative' }}>
            <Icon name="clipboardCheck" size={22} />
            {(Number(effectiveStats?.pending) || 0) > 0 ? (
              <span className="portal-tab-badge">
                {Number(effectiveStats.pending) > 99 ? '99+' : effectiveStats.pending}
              </span>
            ) : null}
          </span>
          <span className="portal-tab-label">Review</span>
        </button>

        <button
          type="button"
          className={`portal-tab-btn ${page === 'users' ? 'active' : ''}`}
          onClick={() => goPage('users')}
        >
          <span className="portal-tab-icon"><Icon name="users" size={22} /></span>
          <span className="portal-tab-label">Surveyors</span>
        </button>

        <button
          type="button"
          className={`portal-tab-btn ${navOpen ? 'active' : ''}`}
          onClick={() => setNavOpen((o) => !o)}
        >
          <span className="portal-tab-icon"><Icon name="menuLines" size={22} /></span>
          <span className="portal-tab-label">Menu</span>
        </button>
      </nav>
    </div>
  )
}
