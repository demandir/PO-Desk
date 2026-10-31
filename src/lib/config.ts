export const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() ?? ''
export const supabaseAnonKey =
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() ?? ''
export const turnstileSiteKey =
  (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined)?.trim() ?? ''

let validUrl = false
try {
  const parsed = new URL(supabaseUrl)
  validUrl = parsed.protocol === 'https:' && !parsed.username && !parsed.password && parsed.pathname === '/'
} catch { /* Empty configuration enables the explicitly labeled local demo. */ }
export const hasSupabaseConfig = validUrl && supabaseAnonKey.length > 20
export const configurationError = (supabaseUrl || supabaseAnonKey) && !hasSupabaseConfig
  ? 'The Supabase connection settings are incomplete or invalid. Check the project URL and public key, then rebuild the site.'
  : ''
