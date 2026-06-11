import { describe, expect, it } from 'vitest'

import { isRetryableError } from '../transcribe-book-content'

describe('isRetryableError', () => {
  it('retries rate limits and 5xx', () => {
    expect(isRetryableError({ status: 429 })).toBe(true)
    expect(isRetryableError({ status: 429, type: 'tokens' })).toBe(true)
    expect(isRetryableError({ status: 500 })).toBe(true)
    expect(isRetryableError({ status: 503 })).toBe(true)
  })

  it('never retries quota / invalid-request, even with a 429 status', () => {
    expect(isRetryableError({ type: 'insufficient_quota' })).toBe(false)
    expect(isRetryableError({ status: 429, type: 'insufficient_quota' })).toBe(
      false
    )
    expect(isRetryableError({ type: 'invalid_request_error' })).toBe(false)
  })

  it('does not retry 4xx client errors (other than 429)', () => {
    expect(isRetryableError({ status: 400 })).toBe(false)
    expect(isRetryableError({ status: 401 })).toBe(false)
    expect(isRetryableError({ status: 404 })).toBe(false)
  })

  it('retries top-level network error codes', () => {
    expect(isRetryableError({ code: 'ECONNRESET' })).toBe(true)
    expect(isRetryableError({ code: 'ETIMEDOUT' })).toBe(true)
  })

  it('retries undici "fetch failed" with the code nested in error.cause', () => {
    // This is the exact shape that dropped ~205 pages on the live run.
    const fetchFailed = new TypeError('fetch failed')
    ;(fetchFailed as any).cause = { code: 'ECONNRESET' }
    expect(isRetryableError(fetchFailed)).toBe(true)
  })

  it('retries a bare "fetch failed" TypeError by message', () => {
    expect(isRetryableError(new TypeError('fetch failed'))).toBe(true)
  })

  it('retries an undici socket timeout nested in cause', () => {
    const err: any = new Error('something')
    err.cause = { code: 'UND_ERR_HEADERS_TIMEOUT' }
    expect(isRetryableError(err)).toBe(true)
  })

  it('does not infinitely loop on a self-referential cause chain', () => {
    const err: any = new Error('weird')
    err.cause = err
    expect(isRetryableError(err)).toBe(false)
  })

  it('returns false for null/undefined and unknown errors', () => {
    expect(isRetryableError(null)).toBe(false)
    expect(isRetryableError(undefined)).toBe(false)
    expect(isRetryableError(new Error('totally unknown'))).toBe(false)
  })
})
