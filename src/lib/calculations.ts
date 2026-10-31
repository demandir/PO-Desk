import type { DashboardStats, LineItemInput, OrderStatus, PurchaseOrder } from '../types'

const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100

export const calculateLineTotal = (item: Pick<LineItemInput, 'quantity' | 'unitPrice'>) =>
  roundMoney(Math.max(0, item.quantity || 0) * Math.max(0, item.unitPrice || 0))

export const calculateTotals = (
  items: Array<Pick<LineItemInput, 'quantity' | 'unitPrice'>>,
) => {
  const subtotal = roundMoney(items.reduce((sum, item) => sum + calculateLineTotal(item), 0))
  return {
    subtotal,
    total: subtotal,
  }
}

export const formatMoney = (value: number, currency = 'USD') =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0)

export const formatDate = (value: string) =>
  new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value))

const allStatuses: OrderStatus[] = [
  'submitted',
  'under_review',
  'needs_information',
  'approved',
  'rejected',
  'ordered',
]

export const calculateDashboardStats = (orders: PurchaseOrder[]): DashboardStats => {
  const byStatus = Object.fromEntries(allStatuses.map((status) => [status, 0])) as Record<
    OrderStatus,
    number
  >
  const now = new Date()
  const monthKeys = Array.from({ length: 6 }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth() - 5 + index, 1)
    return {
      key: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`, // taste-skill-ignore: ISO month keys require zero-padding.
      label: new Intl.DateTimeFormat('en-US', { month: 'short' }).format(date),
      value: 0,
    }
  })

  let approvedValue = 0
  let totalRequestedValue = 0
  const decisionDays: number[] = []

  for (const order of orders) {
    byStatus[order.status] += 1
    totalRequestedValue += order.total
    if (order.status === 'approved' || order.status === 'ordered') approvedValue += order.total
    const month = order.createdAt.slice(0, 7)
    const bucket = monthKeys.find((entry) => entry.key === month)
    if (bucket) bucket.value += order.total
    const decision = order.auditEvents.find((event) =>
      ['approved', 'rejected'].includes(event.newStatus),
    )
    if (decision) {
      decisionDays.push(
        Math.max(
          0,
          (new Date(decision.createdAt).getTime() - new Date(order.createdAt).getTime()) /
            86_400_000,
        ),
      )
    }
  }

  return {
    totalRequests: orders.length,
    needsDecision: byStatus.submitted + byStatus.under_review + byStatus.needs_information,
    approvedValue: roundMoney(approvedValue),
    totalRequestedValue: roundMoney(totalRequestedValue),
    averageDecisionDays: decisionDays.length
      ? roundMoney(decisionDays.reduce((sum, value) => sum + value, 0) / decisionDays.length)
      : 0,
    byStatus,
    monthly: monthKeys.map(({ label, value }) => ({ label, value: roundMoney(value) })),
  }
}
