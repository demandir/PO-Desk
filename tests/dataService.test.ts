import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DemoDataService, ApiDataService } from '../src/services/dataService'
import { createSubmissionAttempt, readPendingSubmission, savePendingSubmission } from '../src/lib/submissionAttempt'
import { functionError } from '../src/lib/serviceErrors'
import type { PurchaseOrderDraft } from '../src/types'

const storage = () => {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) }
}
const draft = (): PurchaseOrderDraft => ({
  requesterName: 'Test Requester',
  departmentId: '00000000-0000-4000-8000-000000000001', vendorName: 'Test Supplies', vendorUrl: '',
  costCenter: '',
  businessReason: 'Restock the office supplies.',
  items: [{ id: 'test-item', description: 'Paper', quantity: 3, unitPrice: 12.34 }],
  currency: 'USD', website: '',
})
beforeEach(() => vi.stubGlobal('window', { localStorage: storage(), sessionStorage: storage() }))

describe('submission recovery and demo workflow', () => {
  it('keeps the original payload and identity across reload and duplicate retries', async () => {
    const input = draft()
    const attempt = createSubmissionAttempt(input)
    input.items[0]!.description = 'Edited later'
    savePendingSubmission(attempt)
    const restored = readPendingSubmission()!
    expect(restored).toEqual(attempt)
    expect(restored.draft.items[0]!.description).toBe('Paper')
    const service = new DemoDataService()
    const first = await service.submitPurchaseOrder(restored.draft, restored.requestCode, restored.idempotencyKey)
    expect(await service.submitPurchaseOrder(restored.draft, restored.requestCode, restored.idempotencyKey)).toEqual(first)
    await service.enterDemo('global_admin')
    expect((await service.listOrders()).filter((order) => order.requesterName === 'Test Requester')).toHaveLength(1)
    const status = await service.lookupPurchaseOrder(restored.requestCode.toLowerCase())
    expect(status?.status).toBe('submitted')
    expect(status).not.toHaveProperty('requesterName')
    expect(status).not.toHaveProperty('total')
    savePendingSubmission(null)
    expect(readPendingSubmission()).toBeNull()
  })

  it('limits department reads and decisions, and requires a rejection note', async () => {
    const service = new DemoDataService()
    await service.enterDemo('department_admin')
    expect((await service.listOrders()).every((order) => order.departmentName === 'Operations')).toBe(true)
    await expect(service.transitionOrder('10000000-0000-4000-8000-000000000013', 'ordered', '')).rejects.toThrow('another department')
    await expect(service.transitionOrder('10000000-0000-4000-8000-000000000014', 'rejected', '')).rejects.toThrow('decision note')
    await service.transitionOrder('10000000-0000-4000-8000-000000000014', 'approved', 'Budget available')
    expect((await service.lookupPurchaseOrder('7k2mb4wn'))?.status).toBe('approved')
    await service.signOut()
    await expect(service.listOrders()).rejects.toThrow('Sign in')
  })

  it('rejects duplicate department codes and restricts department creation', async () => {
    const service = new DemoDataService()
    await service.enterDemo('department_admin')
    await expect(service.addDepartment('Finance', 'FIN')).rejects.toThrow('Global')
    await service.enterDemo('global_admin')
    await service.addDepartment('Finance', 'FIN')
    await expect(service.addDepartment('Another Finance', 'fin')).rejects.toThrow('already in use')
  })
})

describe('production data adapter', () => {
  const respond = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

  it('does not show a successful receipt when the server returns an incomplete response', async () => {
    await expect(new ApiDataService('https://api.test', respond({})).submitPurchaseOrder(draft(), 'code', 'key')).rejects.toThrow('not be confirmed')
  })

  it('distinguishes a rejected submission from an uncertain connection failure', async () => {
    const rejected = await functionError({ context: new Response(JSON.stringify({ error: 'Too many submissions. Try again later.' }), { status: 429 }) })
    expect(rejected.rejected).toBe(true)
    expect(rejected.message).toContain('Too many')
    expect((await functionError(new Error('network'))).rejected).toBe(false)
  })

  it('sends the session token and clears it when the server rejects it', async () => {
    const service = new ApiDataService('https://api.test', respond({ token: 'abc', profile: { user_id: '1', full_name: 'A', role: 'global_admin' } }))
    await service.signIn('admin', 'secret')
    expect(window.sessionStorage.getItem('po-desk-session')).toBe('abc')
    const expired = new ApiDataService('https://api.test', respond({ error: 'Your session has ended.' }, 401))
    expect(await expired.getCurrentProfile()).toBeNull()
    expect(window.sessionStorage.getItem('po-desk-session')).toBeNull()
  })
})
