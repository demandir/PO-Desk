import { z } from 'zod'

const twoDecimals = (value: number) => Math.abs(value * 100 - Math.round(value * 100)) < 0.000001
const precisionMessage = 'Use no more than two decimal places'

// People paste links without a scheme, or with http://; both should still work.
export const normalizeLink = (value: string) => {
  const link = value.trim()
  if (!link) return ''
  return link.includes('://') ? link.replace(/^http:/i, 'https:') : `https://${link}`
}

const httpsUrl = z
  .string()
  .trim()
  .max(500)
  .refine((value) => {
    if (!value) return true
    try { const url = new URL(value); return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password } catch { return false }
  }, 'Check this link. Copy it from your browser and paste it again.')

export const lineItemSchema = z.object({
  id: z.string().min(1),
  description: z.string().trim().min(1, 'Enter what you need').max(500),
  quantity: z.coerce.number().positive('Enter how many you need').max(10_000).refine(twoDecimals, precisionMessage),
  unitPrice: z.coerce.number().positive('Enter the price for one').max(10_000_000).refine(twoDecimals, precisionMessage),
})

export const purchaseOrderSchema = z
  .object({
    requesterName: z.string().trim().min(1, 'Enter your name').max(100),
    departmentId: z.string().uuid('Choose your department'),
    vendorName: z.string().trim().min(1, 'Enter the store or company').max(150),
    vendorUrl: httpsUrl,
    costCenter: z.string().trim().max(50),
    businessReason: z
      .string()
      .trim()
      .min(10, 'Please say a little more about why you need this')
      .max(2_000),
    items: z.array(lineItemSchema).min(1).max(25),
    currency: z.literal('USD'),
    website: z.string().max(0, 'Submission rejected'),
  })
  .superRefine((value, context) => {
    const total =
      value.items.reduce((sum, item) => sum + Math.round((item.quantity * item.unitPrice + Number.EPSILON) * 100) / 100, 0)
    if (total > 10_000_000) {
      context.addIssue({
        code: 'custom',
        path: ['items'],
        message: 'The request total exceeds the supported limit',
      })
    }
  })

export type PurchaseOrderValidation = z.infer<typeof purchaseOrderSchema>

export const flattenValidationErrors = (error: z.ZodError) => {
  const fields: Record<string, string> = {}
  for (const issue of error.issues) {
    const key = issue.path.join('.') || 'form'
    if (!fields[key]) fields[key] = issue.message
  }
  return fields
}
