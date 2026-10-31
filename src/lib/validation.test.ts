import { describe, expect, it } from 'vitest'
import { normalizeLink, purchaseOrderSchema } from './validation'

const validDraft = {
  requesterName: 'Alex Morgan',
  departmentId: '00000000-0000-4000-8000-000000000001',
  vendorName: 'Northline Office Supply',
  vendorUrl: 'https://example.com/quote',
  costCenter: 'OPS-410',
  businessReason: 'Replace damaged task chairs in the support area.',
  items: [{ id: 'item-1', description: 'Task chair', quantity: 6, unitPrice: 489 }],
  currency: 'USD' as const,
  website: '',
}

describe('purchase-order validation', () => {
  it('accepts a complete request', () => {
    expect(purchaseOrderSchema.safeParse(validDraft).success).toBe(true)
  })

  it('rejects an insecure quote URL and empty item description', () => {
    const result = purchaseOrderSchema.safeParse({
      ...validDraft,
      vendorUrl: 'http://example.com/quote',
      items: [{ ...validDraft.items[0], description: '' }],
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'))
      expect(paths).toContain('vendorUrl')
      expect(paths).toContain('items.0.description')
    }
  })

  it('completes links people paste without https', () => {
    expect(normalizeLink(' example.com/chair ')).toBe('https://example.com/chair')
    expect(normalizeLink('http://example.com')).toBe('https://example.com')
    expect(normalizeLink('https://example.com')).toBe('https://example.com')
    expect(normalizeLink('  ')).toBe('')
  })

  it('rejects the honeypot and oversized totals', () => {
    expect(purchaseOrderSchema.safeParse({ ...validDraft, website: 'spam' }).success).toBe(false)
    expect(
      purchaseOrderSchema.safeParse({
        ...validDraft,
        items: [{ ...validDraft.items[0], quantity: 2, unitPrice: 6_000_000 }],
      }).success,
    ).toBe(false)
  })
})
