import { createClient } from 'npm:@supabase/supabase-js@2.118.0'
import {
  clientFingerprint,
  corsHeaders,
  isAllowedOrigin,
  jsonResponse,
  sha256,
} from '../_shared/http.ts'

Deno.serve(async (request) => {
  const origin = request.headers.get('origin')
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) })
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405, origin)
  if (!isAllowedOrigin(origin)) return jsonResponse({ error: 'Origin not allowed.' }, 403, origin)

  try {
    const rawBody = await request.text()
    if (rawBody.length > 1000) return jsonResponse({ error: 'Request is too large.' }, 413, origin)
    let body: { requestCode?: unknown }
    try { body = JSON.parse(rawBody) } catch { return jsonResponse({ error: 'Invalid request body.' }, 400, origin) }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonResponse({ error: 'Invalid request body.' }, 400, origin)
    const requestCode = typeof body.requestCode === 'string' ? body.requestCode.trim().toUpperCase() : ''
    if (!/^(?:REQ-(?:[2-9A-HJ-NP-Z]{4}-){2})?[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/.test(requestCode)) {
      return jsonResponse({ found: false }, 200, origin)
    }

    const client = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { persistSession: false, autoRefreshToken: false } },
    )
    const fingerprint = await clientFingerprint(request, 'lookup')
    const { data: allowed, error: limitError } = await client.rpc('claim_rate_limit', {
      p_bucket: 'lookup-po',
      p_fingerprint: fingerprint,
      p_limit: 60,
    })
    if (limitError) throw limitError
    if (!allowed) return jsonResponse({ error: 'Too many lookups. Try again later.' }, 429, origin)

    const tokenHash = await sha256(requestCode)
    const { data, error } = await client
      .from('purchase_orders')
      .select('status, created_at, updated_at')
      .eq('request_code_hash', tokenHash)
      .maybeSingle()
    if (error) throw error
    if (!data) return jsonResponse({ found: false }, 200, origin)
    return jsonResponse(
      {
        found: true,
        status: data.status,
        submittedAt: data.created_at,
        updatedAt: data.updated_at,
      },
      200,
      origin,
    )
  } catch {
    console.error('lookup-po failed')
    return jsonResponse({ error: 'The request could not be checked.' }, 500, origin)
  }
})
