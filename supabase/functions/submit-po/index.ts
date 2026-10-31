import { createClient } from 'npm:@supabase/supabase-js@2.118.0'
import {
  clientFingerprint,
  corsHeaders,
  isAllowedOrigin,
  jsonResponse,
} from '../_shared/http.ts'
import { validatePurchaseOrderRequest } from '../_shared/validation.ts'

type RequestBody = {
  request?: Record<string, unknown>
  requestCode?: unknown
  idempotencyKey?: unknown
  turnstileToken?: unknown
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

const verifyTurnstile = async (token: string, remoteIp: string) => {
  const secret = Deno.env.get('TURNSTILE_SECRET_KEY')
  if (!secret) return true
  if (!token) return false
  const form = new FormData()
  form.set('secret', secret)
  form.set('response', token)
  form.set('remoteip', remoteIp)
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: form,
  })
  const result = (await response.json()) as { success?: boolean }
  return result.success === true
}

Deno.serve(async (request) => {
  const origin = request.headers.get('origin')
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) })
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405, origin)
  if (!isAllowedOrigin(origin)) return jsonResponse({ error: 'Origin not allowed.' }, 403, origin)

  try {
    const rawBody = await request.text()
    if (rawBody.length > 100_000) return jsonResponse({ error: 'Request is too large.' }, 413, origin)
    let body: RequestBody
    try {
      body = JSON.parse(rawBody) as RequestBody
    } catch {
      return jsonResponse({ error: 'Invalid request body.' }, 400, origin)
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonResponse({ error: 'Invalid request body.' }, 400, origin)
    const payload = body.request && typeof body.request === 'object' && !Array.isArray(body.request)
      ? body.request
      : {}
    const validationError = validatePurchaseOrderRequest(payload)
    if (validationError) return jsonResponse({ error: validationError }, 400, origin)
    const requestCode = text(body.requestCode).toUpperCase()
    const idempotencyKey = text(body.idempotencyKey)
    if (!/^(?:REQ-(?:[2-9A-HJ-NP-Z]{4}-){2})?[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/.test(requestCode) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
      return jsonResponse({ error: 'Invalid submission identity.' }, 400, origin)
    }

    const remoteIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? ''
    if (!(await verifyTurnstile(text(body.turnstileToken), remoteIp))) {
      return jsonResponse({ error: 'Spam-prevention check failed.' }, 400, origin)
    }

    const client = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { persistSession: false, autoRefreshToken: false } },
    )
    const fingerprint = await clientFingerprint(request, 'submit')
    const { data: allowed, error: limitError } = await client.rpc('claim_rate_limit', {
      p_bucket: 'submit-po',
      p_fingerprint: fingerprint,
      p_limit: 10,
    })
    if (limitError) throw limitError
    if (!allowed) return jsonResponse({ error: 'Too many submissions. Try again later.' }, 429, origin)

    const { data, error } = await client.rpc('submit_purchase_order_service', {
      p_request: payload,
      p_request_code: requestCode,
      p_idempotency_key: idempotencyKey,
    })
    if (error) {
      if (['P0001', '22P02', '22007', '22003', '23514', '23502'].includes(error.code)) {
        return jsonResponse({ error: 'The request was not saved. Check the department, dates, and item details before trying again.' }, 400, origin)
      }
      throw error
    }
    const row = Array.isArray(data) ? data[0] : data
    if (!row?.submitted_at) throw new Error('Missing submission receipt')
    return jsonResponse(
      {
        submittedAt: row?.submitted_at,
      },
      201,
      origin,
    )
  } catch {
    console.error('submit-po failed')
    return jsonResponse({ error: 'The request could not be submitted.' }, 500, origin)
  }
})
