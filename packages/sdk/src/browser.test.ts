import { afterEach, expect, it, mock } from 'bun:test'
import { createBookingClient } from './browser.js'
import { createMemorySessionStore } from './session.js'
import { createIdempotencyKey, isUnknownOutcome } from './index.js'

const propertyId = 'public_property_test_0000001'
const websiteOrigin = 'https://stay.example'
const quoteInput = {
  publicUnitReference: 'public_unit_test_0000000001',
  checkIn: '2026-12-10',
  checkOut: '2026-12-12',
  occupancy: { adults: 2, children: 0 },
}
const key = 'quote-key-0000000001'

afterEach(() => mock.restore())

it('a lost mutation response is an unknown outcome and is never silently retried', async () => {
  const fetch = mock().mockRejectedValue(new TypeError('private network detail'))
  const result = await createBookingClient({ websiteOrigin, propertyId, fetch }).createQuote(quoteInput, {
    idempotencyKey: key,
  })
  expect(result).toMatchObject({ ok: false, error: { kind: 'outcome_unknown', recovery: 'retry_same_request' } })
  expect(isUnknownOutcome(result)).toBe(true)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fetch.mock.calls[0]?.[1]?.credentials).toBe('include')
  expect(fetch.mock.calls[0]?.[1]?.headers.get('idempotency-key')).toBe(key)
  expect(String(fetch.mock.calls[0]?.[0])).toBe(`${websiteOrigin}/public/booking-properties/${propertyId}/quotes`)
  if (result.ok) throw new Error('unreachable')
  expect(result.error.kind === 'outcome_unknown' && result.error.message).not.toContain('private network detail')
  // A success the client cannot read is just as unknown: the booking may exist.
  const malformed = mock().mockResolvedValue(Response.json({ unexpected: true }, { status: 201 }))
  expect(
    await createBookingClient({ websiteOrigin, propertyId, fetch: malformed }).createQuote(quoteInput, {
      idempotencyKey: key,
    }),
  ).toMatchObject({ ok: false, error: { kind: 'outcome_unknown' } })
})

const unavailable = (retryable: boolean) =>
  mock().mockResolvedValue(
    Response.json(
      { type: 'about:blank', title: 'Unavailable', status: 503, code: 'SERVICE_UNAVAILABLE', retryable },
      { status: 503 },
    ),
  )

it('never offers a retry of a mutation the server marked not retryable (Chalet website, 21 Oct 2026)', async () => {
  const recovery = async (retryable: boolean) => {
    const result = await createBookingClient({ websiteOrigin, propertyId, fetch: unavailable(retryable) }).createQuote(
      quoteInput,
      { idempotencyKey: key },
    )
    return !result.ok && result.error.kind === 'api' ? result.error.recovery : undefined
  }
  expect(await recovery(true)).toBe('retry_same_request')
  expect(await recovery(false)).toBe('contact_support')
})

it('creates distinct idempotency keys of the documented shape', () => {
  const first = createIdempotencyKey()
  expect(first).toMatch(/^[A-Za-z0-9_-]{16,128}$/)
  expect(first).not.toBe(createIdempotencyKey())
})

it('never follows a redirect', async () => {
  const fetch = mock().mockResolvedValue(Response.json({}))
  await createBookingClient({ websiteOrigin, propertyId, fetch }).property()
  expect(fetch.mock.calls[0]?.[1]?.redirect).toBe('error')
  expect(fetch.mock.calls[0]?.[1]?.cache).toBe('no-store')
})

it('direct mode with a publishable key sends no cookies, keeps the session and capability it is given, and sends each back', async () => {
  const reference = 'public_checkout_test_0000001'
  const capability = 'abcdefghijklmnopqrstuvwxyz012345'
  const created = new Headers({
    'keyset-session': 'abcdefghijklmnopqrstuvwx',
    'keyset-checkout-capability': capability,
  })
  const fetch = mock()
    .mockResolvedValueOnce(
      Response.json(
        {
          publicCheckoutReference: reference,
          expiresAt: '2027-02-01T12:00:00.000Z',
          checkoutState: 'awaiting_payment',
          paymentState: 'created',
          reservationState: 'pending',
          safeNextAction: 'wait',
        },
        { status: 201, headers: created },
      ),
    )
    .mockResolvedValueOnce(
      Response.json(checkoutStatusFixture('completed', 'succeeded', 'confirmed', 'booking_confirmed')),
    )
  const session = createMemorySessionStore()
  const booking = createBookingClient({
    publishableKey: 'pk_test_AbCdEfGhIjKlMnOpQrStUvWx',
    apiOrigin: 'https://api-staging.keyset.cloud',
    propertyId,
    session,
    fetch,
  })
  const start = await booking.startCheckout(
    {
      publicQuoteReference: 'public_quote_test_00000000001',
      bookingContact: { firstName: 'Ada', lastName: 'Example', email: 'ada@example.invalid' },
      acceptance: {
        termsVersion: 'terms-1',
        cancellationPolicyVersion: 'cancellation-1',
        privacyNoticeVersion: 'privacy-1',
        accepted: true,
      },
    },
    { idempotencyKey: 'checkout-key-000000001' },
  )
  expect(start.ok).toBe(true)
  const first = fetch.mock.calls[0]
  expect(first?.[0]).toBe(`https://api-staging.keyset.cloud/public/booking-properties/${propertyId}/checkouts`)
  expect(first?.[1]?.credentials).toBe('omit')
  expect(first?.[1]?.headers.get('keyset-publishable-key')).toBe('pk_test_AbCdEfGhIjKlMnOpQrStUvWx')
  expect(first?.[1]?.headers.get('cookie')).toBeNull()
  expect(await session.read()).toEqual({
    session: 'abcdefghijklmnopqrstuvwx',
    capabilities: { [reference]: capability },
  })
  expect((await booking.checkoutStatus(reference)).ok).toBe(true)
  const second = fetch.mock.calls[1]?.[1]
  expect(second?.headers.get('keyset-session')).toBe('abcdefghijklmnopqrstuvwx')
  expect(second?.headers.get('keyset-checkout-capability')).toBe(capability)
})

it('direct mode refuses a secret key, a malformed key and a plain-http API origin before any call', () => {
  const fetch = mock()
  for (const [publishableKey, apiOrigin] of [
    ['sk_test_ks1_00000000000000000000000000000000', 'https://api-staging.keyset.cloud'],
    ['pk_test_short', 'https://api-staging.keyset.cloud'],
    ['pk_test_AbCdEfGhIjKlMnOpQrStUvWx', 'http://api-staging.keyset.cloud'],
  ] as const)
    expect(() => createBookingClient({ publishableKey, apiOrigin, propertyId, fetch })).toThrow(TypeError)
  expect(fetch).not.toHaveBeenCalled()
})

function checkoutStatusFixture(
  checkoutState: string,
  paymentState: string,
  reservationState: string,
  safeNextAction: string,
  retryAfter?: number,
) {
  return {
    publicCheckoutReference: 'public_checkout_test_0000001',
    expiresAt: '2027-02-01T12:00:00.000Z',
    property: { publicPropertyId: propertyId, displayName: 'Customer Zero Apartments' },
    unit: { publicUnitReference: 'public_unit_test_0000000001', displayName: 'Apartment 1' },
    stay: { checkIn: '2027-02-01', checkOut: '2027-02-03', nights: 2 },
    occupancy: { adults: 2, children: 0 },
    total: { minorUnits: '19500', currency: 'EUR' },
    lineItems: [
      {
        kind: 'nightly_accommodation',
        serviceDate: '2027-02-01',
        label: 'Übernachtung',
        amount: { minorUnits: '9500', currency: 'EUR' },
      },
    ],
    checkoutState,
    paymentState,
    reservationState,
    ...(reservationState === 'confirmed' ? { confirmationReference: 'ABCDEFGH1234' } : {}),
    paymentUi: { kind: 'none' },
    safeNextAction,
    ...(retryAfter === undefined ? {} : { retryAfter }),
  }
}
