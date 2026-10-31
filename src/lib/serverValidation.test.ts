import { describe, expect, it } from 'vitest'
import { validatePurchaseOrderRequest } from '../../supabase/functions/_shared/validation'

const validRequest = {
  requesterName: 'Alex Morgan',
  departmentId: '00000000-0000-4000-8000-000000000001',
  vendorName: 'Northline Office Supply',
  vendorUrl: 'https://example.com/quote',
  costCenter: 'OPS-410',
  businessReason: 'Replace damaged task chairs in the support area.',
  items: [{ description: 'Task chair', quantity: 6, unitPrice: 489 }],
  website: '',
  currency: 'USD',
}

describe('Edge Function purchase-order validation', () => {
  it('accepts a complete bounded request', () => {
    expect(validatePurchaseOrderRequest(validRequest)).toBe('')
  })

  it('rejects malformed department identifiers', () => {
    expect(validatePurchaseOrderRequest({ ...validRequest, departmentId: 'not-a-uuid' })).toBe('Choose a department.')
  })

  it('rejects oversized fields, totals, and the honeypot', () => {
    expect(validatePurchaseOrderRequest({ ...validRequest, costCenter: 'X'.repeat(51) })).toContain('cost center')
    expect(validatePurchaseOrderRequest({ ...validRequest, website: 'spam.example' })).toBe('Submission rejected.')
  })

  it('rejects malformed items, invalid URLs, and extra precision', () => {
    expect(validatePurchaseOrderRequest({ ...validRequest, items: [null] })).toContain('every item')
    expect(validatePurchaseOrderRequest({ ...validRequest, vendorUrl: 'https://' })).toContain('HTTPS')
    expect(validatePurchaseOrderRequest({ ...validRequest, items: [{ description: 'Paper', quantity: 2, unitPrice: 1.234 }] })).toContain('decimal')
  })
})
