import { describe, expect, it } from 'vitest'
import { calculateDashboardStats, calculateLineTotal, calculateTotals, formatDate } from './calculations'
import type { PurchaseOrder } from '../types'

describe('calendar dates', () => {
  it('preserves calendar dates in local time', () => {
    expect(formatDate('2026-11-14')).toBe('Nov 14, 2026')
    expect(formatDate('2026-03-08')).toBe('Mar 8, 2026')
  })
})

describe('purchase-order calculations', () => {
  it('rounds each line and the final total to cents', () => {
    expect(calculateLineTotal({ quantity: 3, unitPrice: 10.005 })).toBe(30.02)
    expect(
      calculateTotals(
        [
          { quantity: 3, unitPrice: 10.005 },
          { quantity: 2, unitPrice: 4.5 },
        ],
      ),
    ).toEqual({ subtotal: 39.02, total: 39.02 })
  })

  it('never produces negative monetary totals', () => {
    expect(calculateTotals([{ quantity: -2, unitPrice: 10 }])).toEqual({
      subtotal: 0,
      total: 0,
    })
  })
})

describe('dashboard calculations', () => {
  it('counts review work and approved value from scoped orders', () => {
    const base = {
      departmentId: '00000000-0000-4000-8000-000000000001',
      departmentName: 'Operations',
      departmentCode: 'OPS',
      requesterName: 'Alex',
      vendorName: 'Vendor',
      vendorUrl: '',
      costCenter: '',
      businessReason: 'A valid business reason.',
      items: [],
      subtotal: 100,
      currency: 'USD' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      auditEvents: [],
    }
    const orders: PurchaseOrder[] = [
      { ...base, id: '1', reference: 'PO-26-00001', status: 'submitted', total: 100 },
      { ...base, id: '2', reference: 'PO-26-00002', status: 'approved', total: 250 },
    ]
    const stats = calculateDashboardStats(orders)
    expect(stats.totalRequests).toBe(2)
    expect(stats.needsDecision).toBe(1)
    expect(stats.approvedValue).toBe(250)
    expect(stats.totalRequestedValue).toBe(350)
  })
})
