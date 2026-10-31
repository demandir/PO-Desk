import { describe, expect, it } from 'vitest'
import { makeRequestCode, normalizeRequestCode } from './secrets'

describe('makeRequestCode', () => {
  it('creates a two-block code using unambiguous characters', () => {
    expect(makeRequestCode()).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/)
  })

  it('does not repeat codes across a small sample', () => {
    const sample = new Set(Array.from({ length: 100 }, makeRequestCode))
    expect(sample.size).toBe(100)
  })
})

describe('normalizeRequestCode', () => {
  it('accepts lowercase, spaced, and unhyphenated codes', () => {
    expect(normalizeRequestCode(' 7k2m-b4wn ')).toBe('7K2M-B4WN')
    expect(normalizeRequestCode('7k2mb4wn')).toBe('7K2M-B4WN')
  })

  it('keeps earlier long codes intact', () => {
    expect(normalizeRequestCode('req-7k2m-b4wn-9q3r-6t8y')).toBe('REQ-7K2M-B4WN-9Q3R-6T8Y')
  })
})
