import { useCallback, useEffect, useMemo, useState } from 'react'
import { StatusBadge } from '../components/StatusBadge'
import { calculateDashboardStats, formatDate, formatMoney } from '../lib/calculations'
import { dataService } from '../services/dataService'
import type {
  AdminProfile,
  DashboardStats,
  Department,
  OrderStatus,
  PurchaseOrder,
} from '../types'
import { allowedTransitions, statusLabels } from '../types'

type StatusFilter = OrderStatus | 'all' | 'accepted'

const acceptedStatuses: OrderStatus[] = ['approved', 'ordered']

const filterStatuses: StatusFilter[] = [
  'all',
  'accepted',
  'submitted',
  'under_review',
  'needs_information',
  'approved',
  'rejected',
  'ordered',
]

function StatChart({ stats }: { stats: DashboardStats }) {
  const max = Math.max(...stats.monthly.map((entry) => entry.value), 1)
  return (
    <section className="stats-chart" data-ui aria-labelledby="stats-chart-heading">
      <div className="stats-chart__headline">
        <strong>{formatMoney(stats.totalRequestedValue)}</strong>
        <h2 id="stats-chart-heading">Requested in view</h2>
      </div>
      <div className="stats-chart__bars" aria-label="Requested value over six months">
        {stats.monthly.map((entry, index) => (
          <div className="stats-chart__bar-group" key={entry.label}>
            <span className="stats-chart__value">
              {entry.value > 0 ? formatMoney(entry.value) : '$0'}
            </span>
            <span
              className={`stats-chart__bar ${index === stats.monthly.length - 1 ? 'stats-chart__bar--current' : ''}`}
              style={{ '--bar-height': `${Math.max(5, (entry.value / max) * 100)}%` } as React.CSSProperties}
            />
            <span className="stats-chart__label">{entry.label}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

function OrderDetail({
  order,
  onTransition,
}: {
  order: PurchaseOrder
  onTransition: (status: OrderStatus, note: string) => Promise<void>
}) {
  const [targetStatus, setTargetStatus] = useState<OrderStatus | ''>('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState('')

  useEffect(() => {
    setTargetStatus('')
    setNote('')
    setError('')
    setSaved('')
  }, [order.id])

  const save = async () => {
    if (!targetStatus) return
    if (['needs_information', 'rejected'].includes(targetStatus) && note.trim().length < 5) {
      setError('Add a short note so the decision is understandable later.')
      return
    }
    setSaving(true)
    setError('')
    try {
      await onTransition(targetStatus, note)
      setSaved(`Status updated to ${statusLabels[targetStatus]}.`)
      setTargetStatus('')
      setNote('')
    } catch (transitionError) {
      setError(transitionError instanceof Error ? transitionError.message : 'The status could not be changed.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <article className="order-detail" id="order-detail" tabIndex={-1} aria-labelledby="order-detail-heading">
      <header className="order-detail__header">
        <div>
          <span>{order.reference}</span>
          <h2 id="order-detail-heading">{order.vendorName}</h2>
        </div>
        <StatusBadge status={order.status} />
      </header>
      {saved && <p className="save-confirmation" role="status">{saved}</p>}

      <div className="order-detail__facts">
        <dl>
          <div><dt>Requester</dt><dd>{order.requesterName}</dd></div>
          <div><dt>Department</dt><dd>{order.departmentName}</dd></div>
          <div><dt>Project name</dt><dd>{order.costCenter || 'Not provided'}</dd></div>
        </dl>
        <div className="order-detail__reason">
          <h3>Business reason</h3>
          <p>{order.businessReason}</p>
          {order.vendorUrl && (
            <a href={order.vendorUrl} target="_blank" rel="noreferrer">
              Open quote or product link
            </a>
          )}
        </div>
      </div>

      <div className="order-table-wrap">
        <table className="order-table">
          <caption>Requested items</caption>
          <thead>
            <tr><th>Item</th><th>Quantity</th><th>Unit price</th><th>Total</th></tr>
          </thead>
          <tbody>
            {order.items.map((item) => (
              <tr key={item.id}>
                <td>{item.description}</td>
                <td>{item.quantity}</td>
                <td>{formatMoney(item.unitPrice)}</td>
                <td>{formatMoney(item.lineTotal)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><th colSpan={3}>Request total</th><td>{formatMoney(order.total)}</td></tr>
          </tfoot>
        </table>
      </div>

      {allowedTransitions[order.status].length > 0 && (
        <section className="decision-panel" aria-labelledby="decision-heading">
          <h3 id="decision-heading">Record a decision</h3>
          <div className="decision-panel__fields">
            <label className="field field--dark">
              <span>Next status</span>
              <select
                value={targetStatus}
                onChange={(event) => setTargetStatus(event.target.value as OrderStatus | '')}
              >
                <option value="">Choose status</option>
                {allowedTransitions[order.status].map((status) => (
                  <option value={status} key={status}>{statusLabels[status]}</option>
                ))}
              </select>
            </label>
            <label className="field field--dark">
              <span>Decision note</span>
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={3}
                maxLength={1000}
                placeholder="Required when information is needed or the request is rejected"
              />
            </label>
          </div>
          {error && <p className="form-message form-message--error" role="alert">{error}</p>}
          <button
            className="button button--primary"
            type="button"
            disabled={!targetStatus || saving}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : 'Save decision'}
          </button>
        </section>
      )}

      <section className="audit-history" aria-labelledby="history-heading">
        <h3 id="history-heading">History</h3>
        <ol>
          {[...order.auditEvents]
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .map((event) => (
              <li key={event.id}>
                <div><strong>{statusLabels[event.newStatus]}</strong><span>{formatDate(event.createdAt)}</span></div>
                <p>{event.note}</p>
                <small>{event.actorName}</small>
              </li>
            ))}
        </ol>
      </section>
    </article>
  )
}

function DepartmentManager({
  departments,
  onAdded,
}: {
  departments: Department[]
  onAdded: (department: Department) => void
}) {
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const add = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    if (name.trim().length < 2 || !/^[A-Za-z0-9-]{2,8}$/.test(code.trim())) {
      setError('Enter a department name and a 2–8 character code.')
      return
    }
    setSaving(true)
    try {
      const department = await dataService.addDepartment(name, code)
      onAdded(department)
      setName('')
      setCode('')
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : 'Department could not be added.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="department-manager" aria-labelledby="department-manager-heading">
      <div>
        <h2 id="department-manager-heading">Departments</h2>
        <p>These choices appear on the no-login request form.</p>
        <ul>
          {departments.map((department) => (
            <li key={department.id}><strong>{department.name}</strong><span>{department.code}</span></li>
          ))}
        </ul>
      </div>
      <form onSubmit={(event) => void add(event)}>
        <label className="field field--gold">
          <span>Department name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} />
        </label>
        <label className="field field--gold">
          <span>Short code</span>
          <input value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} maxLength={8} />
        </label>
        {error && <p className="form-message form-message--error" role="alert">{error}</p>}
        <button className="button button--deep" type="submit" disabled={saving}>
          {saving ? 'Adding…' : 'Add department'}
        </button>
      </form>
    </section>
  )
}

function PasswordChange() {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    setSaved(false)
    if (newPassword !== confirmPassword) {
      setError('The new passwords do not match.')
      return
    }
    setSaving(true)
    try {
      await dataService.changePassword(currentPassword, newPassword)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setSaved(true)
    } catch (changeError) {
      setError(changeError instanceof Error ? changeError.message : 'Your password could not be changed.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="password-form" onSubmit={(event) => void submit(event)}>
      <label className="field">
        <span>Current password</span>
        <input
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
          required
        />
      </label>
      <label className="field">
        <span>New password</span>
        <input
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={200}
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          aria-describedby="new-password-help"
          required
        />
        <small id="new-password-help">Use at least 12 characters.</small>
      </label>
      <label className="field">
        <span>Confirm new password</span>
        <input
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          required
        />
      </label>
      {error && <p className="form-message form-message--error" role="alert">{error}</p>}
      {saved && <p className="form-message" role="status">Password changed. Other signed-in devices have been signed out.</p>}
      <button className="button button--primary" type="submit" disabled={saving}>
        {saving ? 'Saving…' : 'Change password'}
      </button>
    </form>
  )
}

export function AdminDashboardPage({
  profile,
  onSignOut,
}: {
  profile: AdminProfile
  onSignOut: () => Promise<void>
}) {
  const [orders, setOrders] = useState<PurchaseOrder[]>([])
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [departments, setDepartments] = useState<Department[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [departmentFilter, setDepartmentFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [nextOrders, nextDepartments] = await Promise.all([
        dataService.listOrders(),
        dataService.listDepartments(),
      ])
      setOrders(nextOrders)
      setStats(calculateDashboardStats(nextOrders))
      setDepartments(nextDepartments)
      setSelectedId((current) =>
        current && nextOrders.some((order) => order.id === current) ? current : nextOrders[0]?.id ?? '',
      )
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Dashboard data could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const filteredOrders = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return orders.filter((order) => {
      if (statusFilter === 'accepted' && !acceptedStatuses.includes(order.status)) return false
      if (statusFilter !== 'all' && statusFilter !== 'accepted' && order.status !== statusFilter) return false
      if (departmentFilter !== 'all' && order.departmentId !== departmentFilter) return false
      if (!normalized) return true
      return [
        order.reference,
        order.requesterName,
        order.vendorName,
        order.departmentName,
        order.costCenter,
      ].some((value) => value.toLowerCase().includes(normalized))
    })
  }, [departmentFilter, orders, query, statusFilter])

  const showStatus = (status: StatusFilter) => {
    setStatusFilter(status)
    setQuery('')
    setDepartmentFilter('all')
  }
  const acceptedCount = orders.filter((order) => acceptedStatuses.includes(order.status)).length
  const declinedCount = orders.filter((order) => order.status === 'rejected').length

  const selectedOrder = filteredOrders.find((order) => order.id === selectedId) ?? filteredOrders[0] ?? null

  const transition = async (status: OrderStatus, note: string) => {
    if (!selectedOrder) return
    await dataService.transitionOrder(selectedOrder.id, status, note)
    await load()
  }

  if (loading && !stats) {
    return <main id="main-content" className="loading-page" aria-live="polite">Loading the purchase ledger…</main>
  }

  return (
    <main id="main-content" className="dashboard-page">
      <section className="dashboard-intro">
        <div>
          <h1>{profile.role === 'global_admin' ? 'All purchase requests' : `${profile.departmentName ?? 'Department'} requests`}</h1>
          <p>
            {profile.role === 'global_admin'
              ? 'Every department, current commitments, and the work waiting for a decision.'
              : `Review requests assigned to ${profile.departmentName ?? 'your department'} and keep each decision in the record.`}
          </p>
        </div>
        <div className="dashboard-user">
          <span>{profile.fullName}</span>
          <strong>{profile.role === 'global_admin' ? 'Global administrator' : `${profile.departmentName} administrator`}</strong>
          <button className="button button--quiet" type="button" disabled={loading} onClick={() => void load()}>{loading ? 'Refreshing…' : 'Refresh requests'}</button>
        </div>
      </section>

      {error && <div className="dashboard-error" role="alert">{error}</div>}

      {stats && (
        <>
          <section className="stat-strip" aria-label="Purchase order summary">
            <div><strong>{stats.needsDecision}</strong><span>Need a decision</span></div>
            <div><strong>{stats.totalRequests}</strong><span>Requests in view</span></div>
            <div><strong>{formatMoney(stats.approvedValue)}</strong><span>Approved value</span></div>
            <div><strong>{stats.averageDecisionDays.toFixed(1)} days</strong><span>Average decision</span></div>
          </section>
        </>
      )}

      <section className="ledger-section" aria-labelledby="ledger-heading">
        <div className="ledger-heading">
          <div>
            <h2 id="ledger-heading">Review requests</h2>
            <p>{filteredOrders.length} requests match the current view.</p>
          </div>
          <div className="ledger-filters">
            <label className="field field--compact">
              <span>Search</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Reference, person, vendor"
              />
            </label>
            <label className="field field--compact">
              <span>Status</span>
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
              >
                {filterStatuses.map((status) => (
                  <option key={status} value={status}>
                    {status === 'all' ? 'All statuses' : status === 'accepted' ? 'Accepted or ordered' : statusLabels[status]}
                  </option>
                ))}
              </select>
            </label>
            {profile.role === 'global_admin' && (
              <label className="field field--compact">
                <span>Department</span>
                <select value={departmentFilter} onChange={(event) => setDepartmentFilter(event.target.value)}>
                  <option value="all">All departments</option>
                  {departments.map((department) => (
                    <option value={department.id} key={department.id}>{department.name}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </div>
        <div className="filter-actions">
          <button type="button" className="text-button text-button--strong" onClick={() => showStatus('submitted')}>Show new requests</button>
          {profile.role === 'global_admin' && (
            <>
              <button type="button" className="text-button text-button--strong" onClick={() => showStatus('accepted')}>Show accepted ({acceptedCount})</button>
              <button type="button" className="text-button text-button--strong" onClick={() => showStatus('rejected')}>Show declined ({declinedCount})</button>
            </>
          )}
          {(query || statusFilter !== 'all' || departmentFilter !== 'all') && <button type="button" className="text-button" onClick={() => { setQuery(''); setStatusFilter('all'); setDepartmentFilter('all') }}>Clear filters</button>}
        </div>

        <div className="ledger-layout">
          <div className="order-list" aria-label="Purchase requests">
            {filteredOrders.length ? (
              filteredOrders.map((order) => (
                <button
                  type="button"
                  className={`order-row ${selectedOrder?.id === order.id ? 'order-row--selected' : ''}`}
                  onClick={() => {
                    setSelectedId(order.id)
                    if (window.matchMedia('(max-width: 1000px)').matches) requestAnimationFrame(() => document.getElementById('order-detail')?.focus())
                  }}
                  key={order.id}
                  aria-pressed={selectedOrder?.id === order.id}
                >
                  <span className="order-row__main"><strong>{order.vendorName}</strong><small>{order.reference} · {order.requesterName}</small></span>
                  <span className="order-row__department">{order.departmentName}</span>
                  <StatusBadge status={order.status} />
                  <strong className="order-row__total">{formatMoney(order.total)}</strong>
                </button>
              ))
            ) : (
              <div className="empty-state">No requests match these filters.</div>
            )}
          </div>
          {selectedOrder && <OrderDetail key={selectedOrder.id} order={selectedOrder} onTransition={transition} />}
        </div>
      </section>

      {dataService.mode === 'live' && <details className="dashboard-disclosure"><summary>Change password</summary><PasswordChange /></details>}

      {stats && <details className="dashboard-disclosure"><summary>Spending overview</summary><StatChart stats={stats} /></details>}

      {profile.role === 'global_admin' && (
        <details className="dashboard-disclosure"><summary>Manage departments</summary><DepartmentManager
          departments={departments}
          onAdded={(department) => setDepartments((current) => [...current, department])}
        /></details>
      )}
    </main>
  )
}
