export const allowedOrigins = () =>
  (Deno.env.get('ALLOWED_ORIGINS') ?? 'http://localhost:5173,http://localhost:4173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)

export const corsHeaders = (origin: string | null) => {
  const allowed = allowedOrigins()
  const selected = origin && allowed.includes(origin) ? origin : allowed[0] ?? ''
  return {
    'Access-Control-Allow-Origin': selected,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

export const isAllowedOrigin = (origin: string | null) =>
  Boolean(origin && allowedOrigins().includes(origin))

export const jsonResponse = (
  body: Record<string, unknown>,
  status: number,
  origin: string | null,
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })

export const sha256 = async (value: string) => {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export const clientFingerprint = async (request: Request, suffix: string) => {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  const salt = Deno.env.get('RATE_LIMIT_SALT') ?? 'local-development-only'
  return sha256(`${forwarded}:${suffix}:${salt}`)
}
