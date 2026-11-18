import { afterEach, describe, expect, it, mock } from 'bun:test'
import { createKeyset, parseDeveloperEvents } from './developer.js'
const property = '20000000-0000-4000-8000-000000000001'
const key = () =>
  `sk_test_ks1_${crypto.randomUUID().replaceAll('-', '')}_${btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  )
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')}`
afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window')
  mock.restore()
})
/** Puts a stand-in `window` on the global object, as a browser would have one; `afterEach` takes it away again. */
function stubWindow(value: object): void {
  Object.defineProperty(globalThis, 'window', { value, configurable: true, writable: true })
}

describe('server credential SDK', () => {
  it('sends Authorization only through the server client and refuses browser execution', async () => {
    const secret = key()
    const fetch = mock<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ id: property, name: 'Synthetic', timezone: 'Europe/Berlin', currency: 'EUR', units: [] }),
      ),
    )
    const client = createKeyset({ secretKey: secret, apiBaseUrl: 'https://api-staging.keyset.cloud', fetch })
    expect((await client.getProperty(property)).ok).toBe(true)
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization') === `Bearer ${secret}`).toBe(true)
    expect(JSON.stringify(client).includes(secret)).toBe(false)
    stubWindow({})
    expect(() => createKeyset({ secretKey: secret, apiBaseUrl: 'https://api-staging.keyset.cloud' })).toThrow()
    await client.getProperty(property)
    expect(fetch).toHaveBeenCalledTimes(1)
    // Nor can a browser bundle reach the credential factory through the browser or root entrypoint.
    expect('createKeyset' in (await import('./browser.js'))).toBe(false)
    expect('createKeyset' in (await import('./index.js'))).toBe(false)
  })

  it('keeps a lost mutation uncertain without retrying or changing its idempotency key', async () => {
    const fetch = mock<typeof globalThis.fetch>().mockRejectedValue(new Error('lost'))
    const client = createKeyset({ secretKey: key(), apiBaseUrl: 'https://api-staging.keyset.cloud', fetch })
    const result = await client.createReservation(
      property,
      {
        unitId: property,
        checkIn: '2026-11-01',
        checkOut: '2026-11-03',
        occupancy: { adults: 2, children: 0 },
        contact: { firstName: 'Synthetic', lastName: 'Guest' },
        agreedTotalMinor: '10000',
        currency: 'EUR',
      },
      { idempotencyKey: 'synthetic-intent-0001' },
    )
    expect(result).toMatchObject({ ok: false, error: { kind: 'outcome_unknown', recovery: 'retry_same_request' } })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('idempotency-key')).toBe('synthetic-intent-0001')
  })

  // P1-API-012 F4: the contract gate calls a new problem code ADDITIVE only because an installed SDK keeps reading the
  // problem. Were it unreadable, a definite refusal of a write would become `outcome_unknown` and invite a retry.
  it('reads a problem code newer than the SDK as a refusal with its status and retryable, not as a lost answer', async () => {
    const answer = (code: unknown, retryable: boolean) =>
      new Response(JSON.stringify({ type: 'about:blank', title: 'Synthetic', status: 409, code, retryable }), {
        status: 409,
        headers: { 'content-type': 'application/problem+json' },
      })
    const fetch = mock<typeof globalThis.fetch>()
      .mockResolvedValueOnce(answer('SOMETHING_NEW_LATER', false))
      .mockResolvedValueOnce(answer('IDEMPOTENCY_OUTCOME_UNKNOWN', false))
      .mockResolvedValueOnce(answer('not a code', false))
    const client = createKeyset({ secretKey: key(), apiBaseUrl: 'https://api-staging.keyset.cloud', fetch })
    expect(await client.getProperty(property)).toMatchObject({
      ok: false,
      error: {
        kind: 'api',
        recovery: 'contact_support',
        problem: { code: 'UNRECOGNIZED_PROBLEM', serverCode: 'SOMETHING_NEW_LATER', status: 409, retryable: false },
      },
    })
    expect(await client.getProperty(property)).toMatchObject({
      ok: false,
      error: { kind: 'api', recovery: 'retry_read', problem: { code: 'IDEMPOTENCY_OUTCOME_UNKNOWN' } },
    })
    expect(await client.getProperty(property)).toMatchObject({ ok: false, error: { kind: 'transport' } })
  })

  it('returns an event type it does not know as unrecognized and still refuses a malformed one', () => {
    const entry = (type: unknown) => ({
      id: `evt_${'a'.repeat(32)}`,
      type,
      createdAt: '2026-11-01T10:00:00Z',
      data: {},
    })
    const page = parseDeveloperEvents({
      hasMore: false,
      events: [entry('payment.received'), entry('reservation.moved')],
    })
    expect(page.events.map((e) => e.type)).toEqual(['payment.received', 'unrecognized'])
    expect(page.events[1]).toMatchObject({ type: 'unrecognized', serverType: 'reservation.moved' })
    for (const bad of ['Reservation.Moved', 'nodot', 'a.b c', `a.${'b'.repeat(80)}`, 7])
      expect(() => parseDeveloperEvents({ hasMore: false, events: [entry(bad)] })).toThrow()
  })
})
