import type { PurchaseOrderDraft } from '../types'
import { makeIdempotencyKey, makeRequestCode } from './secrets'
import { purchaseOrderSchema } from './validation'

export interface SubmissionAttempt {
  draft: PurchaseOrderDraft
  requestCode: string
  idempotencyKey: string
}
const storageKey = 'po-desk-pending-submission'

export const createSubmissionAttempt = (draft: PurchaseOrderDraft): SubmissionAttempt => ({
  draft: structuredClone(draft),
  requestCode: makeRequestCode(),
  idempotencyKey: makeIdempotencyKey(),
})

export const readPendingSubmission = (): SubmissionAttempt | null => {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(storageKey) ?? 'null')
    if (!value || !/^(?:REQ-(?:[2-9A-HJ-NP-Z]{4}-){2})?[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/.test(value.requestCode) ||
        !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value.idempotencyKey)) return null
    const checked = purchaseOrderSchema.safeParse(value.draft)
    return checked.success ? { ...value, draft: checked.data } as SubmissionAttempt : null
  } catch { return null }
}

export const savePendingSubmission = (attempt: SubmissionAttempt | null) => {
  try {
    if (attempt) window.sessionStorage.setItem(storageKey, JSON.stringify(attempt))
    else window.sessionStorage.removeItem(storageKey)
  } catch { /* In-memory retries still work when browser storage is unavailable. */ }
}
