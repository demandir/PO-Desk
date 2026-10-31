export const makeRequestCode = () => {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  const characters = Array.from(bytes, (byte) => alphabet[byte & 31]).join('')
  return `${characters.slice(0, 4)}-${characters.slice(4)}`
}

// People may retype a code in lowercase or without its hyphen.
export const normalizeRequestCode = (code: string) => {
  const compact = code.toUpperCase().replace(/[\s-]/g, '')
  return compact.length === 8 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : code.trim().toUpperCase()
}

export const makeIdempotencyKey = () => crypto.randomUUID()
