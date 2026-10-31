type Item = { description?: unknown; quantity?: unknown; unitPrice?: unknown }

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
const finiteNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value)
const twoDecimals = (value: unknown) => finiteNumber(value) && Math.abs(Number(value) * 100 - Math.round(Number(value) * 100)) < 0.000001
const secureUrl = (value: string) => {
  try { const url = new URL(value); return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password } catch { return false }
}

export const validatePurchaseOrderRequest = (
  request: Record<string, unknown>,
) => {
  const items = Array.isArray(request.items) ? (request.items as Item[]) : []
  const vendorUrl = text(request.vendorUrl)

  if (text(request.website)) return 'Submission rejected.'
  if (!text(request.requesterName) || text(request.requesterName).length > 100) return 'Enter your name.'
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text(request.departmentId))) return 'Choose a department.'
  if (!text(request.vendorName) || text(request.vendorName).length > 150) return 'Enter the vendor.'
  if (vendorUrl.length > 500 || (vendorUrl && !secureUrl(vendorUrl))) return 'Use a valid HTTPS quote link.'
  if (text(request.costCenter).length > 50) return 'Check the cost center or project code.'

  if (text(request.businessReason).length < 10 || text(request.businessReason).length > 2000) return 'Explain why the order is needed.'
  if (items.length < 1 || items.length > 25) return 'Add between 1 and 25 items.'

  let subtotal = 0
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return 'Check every item.'
    if (!text(item.description) || text(item.description).length > 500) return 'Describe every item.'
    if (!finiteNumber(item.quantity) || Number(item.quantity) <= 0 || Number(item.quantity) > 10000) return 'Check item quantities.'
    if (!finiteNumber(item.unitPrice) || Number(item.unitPrice) < 0 || Number(item.unitPrice) > 10000000) return 'Check item prices.'
    if (!twoDecimals(item.quantity) || !twoDecimals(item.unitPrice)) return 'Use no more than two decimal places for quantities and prices.'
    subtotal += Math.round((Number(item.quantity) * Number(item.unitPrice) + Number.EPSILON) * 100) / 100
  }

  if (request.currency !== 'USD') return 'Currency must be USD.'
  if (subtotal > 10000000) return 'The request total exceeds the supported limit.'
  return ''
}
