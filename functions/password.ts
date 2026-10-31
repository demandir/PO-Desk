import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

const cost = 32_768
const blockSize = 8
const parallelization = 1
const keyLength = 32

const derive = (password: string, salt: Buffer, N: number) =>
  new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, keyLength, { N, r: blockSize, p: parallelization, maxmem: 128 * N * blockSize * 2 }, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })

export const hashPassword = async (password: string) => {
  const salt = randomBytes(16)
  const key = await derive(password, salt, cost)
  return `scrypt$${cost}$${salt.toString('base64')}$${key.toString('base64')}`
}

export const verifyPassword = async (password: string, stored: string) => {
  const [scheme, N, salt, key] = stored.split('$')
  if (scheme !== 'scrypt' || !N || !salt || !key) return false
  const expected = Buffer.from(key, 'base64')
  const actual = await derive(password, Buffer.from(salt, 'base64'), Number(N))
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

// Compared against when a username is unknown, so both cases take the same time.
export const decoyHash = `scrypt$${cost}$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(keyLength).toString('base64')}`
