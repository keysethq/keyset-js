import { expect, it, mock } from 'bun:test'
import { createBookingClient, createBookingRelay, createMemorySessionStore } from './server.js'

const propertyId = 'public_property_test_0000001'
const origin = 'https://stay.example'
const path = `/public/booking-properties/${propertyId}`
const request = (suffix = '', init?: RequestInit) => new Request(origin + path + suffix, init)
const relayOptions = { websiteOrigin: origin, apiOrigin: 'https://api.example', propertyId }

it('refuses cross-origin mutations and cross-site reads before forwarding', async () => {
  const fetch = mock()
  const relay = createBookingRelay({ ...relayOptions, fetch })
  expect(
    (await relay(request('/search', { method: 'POST', headers: { origin: 'https://evil.example' } }))).status,
  ).toBe(403)
  expect((await relay(request('', { headers: { 'sec-fetch-site': 'cross-site' } }))).status).toBe(403)
  expect(fetch).not.toHaveBeenCalled()
})

it('scopes cookies, strips spoofed identity, credentials and upstream cookie domains', async () => {
  const fetch = mock().mockResolvedValue(
    new Response('{}', {
      headers: {
        'set-cookie':
          'keyset_public_session=abcdefghijklmnopqrstuvwx; Domain=api.example; Path=/public; HttpOnly; SameSite=Lax',
      },
    }),
  )
  const relay = createBookingRelay({ ...relayOptions, fetch })
  const response = await relay(
    request('', {
      headers: {
        cookie: 'operator=secret; keyset_public_session=abcdefghijklmnopqrstuvwx; keyset_checkout_other=secret',
        authorization: 'secret',
        'x-forwarded-for': '198.51.100.1',
        'x-keyset-ingress-client-address': '198.51.100.40',
        'x-keyset-proxy-signature': 'secret',
      },
    }),
  )
  const headers = fetch.mock.calls[0]?.[1]?.headers
  expect(headers.get('cookie')).toBe('keyset_public_session=abcdefghijklmnopqrstuvwx')
  expect(headers.get('authorization')).toBeNull()
  expect(headers.get('x-forwarded-for')).toBeNull()
  expect(headers.get('x-keyset-ingress-client-address')).toBeNull()
  expect(headers.get('x-keyset-proxy-signature')).toBeNull()
  expect(response.headers.get('set-cookie')).toBe(
    'keyset_public_session=abcdefghijklmnopqrstuvwx; Path=/public; HttpOnly; SameSite=Lax; Secure; Max-Age=86400',
  )
})

it('refuses another property, encoded separators, query parameters and oversized bodies', async () => {
  const fetch = mock()
  const relay = createBookingRelay({ ...relayOptions, fetch })
  for (const url of ['/public/booking-properties/other', `${path}?target=elsewhere`, `${path}%2fsearch`])
    expect((await relay(new Request(origin + url))).status).toBe(404)
  expect(
    (
      await relay(
        request('/quotes', {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json' },
          body: 'x'.repeat(16385),
        }),
      )
    ).status,
  ).toBe(413)
  expect(fetch).not.toHaveBeenCalled()
})

it('refuses a calendar query that smuggles in a tenant, a repeated or an encoded parameter', async () => {
  const fetch = mock()
  const relay = createBookingRelay({ ...relayOptions, fetch })
  for (const query of [
    '?from=2027-02-05&nights=31&adults=2&children=0&tenantId=x',
    '?from=2027-02-05&nights=31&adults=2&children=0&children=1',
    '?from=2027-02-05&nights=31&adults=2%26x%3D1&children=0',
    '?from=2027-02-05&nights=31&adults=2&children=0&publicUnitReference=public_unit_e2e_apartment_1_000%26x%3D1',
  ])
    expect((await relay(request(`/availability${query}`))).status, query).toBe(422)
  expect(
    (
      await relay(
        request('/availability?from=2027-02-05&nights=31&adults=2&children=0', {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json' },
          body: '{}',
        }),
      )
    ).status,
  ).toBe(404)
  expect((await relay(request('/search?from=2027-02-05&nights=31&adults=2&children=0'))).status).toBe(404)
  expect(fetch).not.toHaveBeenCalled()
})

it('forwards only the matching Checkout capability and never unrelated upstream cookies', async () => {
  const reference = 'public_checkout_test_0000001'
  const headers = new Headers()
  headers.append('set-cookie', 'operator_session=secret; Path=/; HttpOnly')
  headers.append('set-cookie', `keyset_checkout_${reference}=abcdefghijklmnopqrstuvwxyz012345; Domain=api.example`)
  headers.append('set-cookie', 'keyset_checkout_other_checkout_000001=abcdefghijklmnopqrstuvwxyz012345')
  const fetch = mock().mockResolvedValue(Response.json({ safe: true }, { headers }))
  const relay = createBookingRelay({ ...relayOptions, fetch })
  const result = await relay(
    new Request(`${origin}/public/checkouts/${reference}`, {
      headers: {
        cookie: `keyset_checkout_${reference}=abcdefghijklmnopqrstuvwxyz012345; keyset_checkout_other_checkout_000001=abcdefghijklmnopqrstuvwxyz012345; operator=secret`,
      },
    }),
  )
  expect(fetch.mock.calls[0]?.[1]?.headers.get('cookie')).toBe(
    `keyset_checkout_${reference}=abcdefghijklmnopqrstuvwxyz012345`,
  )
  expect(result.headers.getSetCookie()).toEqual([
    `keyset_checkout_${reference}=abcdefghijklmnopqrstuvwxyz012345; Path=/public/checkouts; HttpOnly; SameSite=Lax; Secure; Max-Age=2592000`,
  ])
  expect(result.headers.get('cache-control')).toBe('private, no-store')
})

it('refuses upstream redirects, malformed Checkout success and insecure production configuration', async () => {
  expect(() => createBookingRelay({ ...relayOptions, websiteOrigin: 'http://stay.example' })).toThrow()
  for (const upstream of [
    new Response(null, { status: 302, headers: { location: 'https://evil.example' } }),
    Response.json({ publicCheckoutReference: 'invalid' }, { status: 201 }),
  ]) {
    const fetch = mock().mockResolvedValue(upstream)
    const relay = createBookingRelay({ ...relayOptions, fetch })
    const result = await relay(
      request('/checkouts', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' }),
    )
    expect(result.status).toBe(502)
    expect(result.headers.get('set-cookie')).toBeNull()
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe('manual')
  }
})

const serverOptions = { apiBaseUrl: 'https://api.example', propertyId }

it('the server client keeps the session and only the matching capability in the caller store', async () => {
  const reference = 'public_checkout_test_0000001'
  const capability = 'abcdefghijklmnopqrstuvwxyz012345'
  const created = new Headers()
  created.append('set-cookie', 'keyset_public_session=abcdefghijklmnopqrstuvwx; Path=/public; HttpOnly')
  created.append('set-cookie', `keyset_checkout_${reference}=${capability}; Path=/public/checkouts; HttpOnly`)
  created.append('set-cookie', 'unrelated=value')
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
    .mockResolvedValueOnce(Response.json(status('completed', 'succeeded', 'confirmed', 'booking_confirmed')))
  const session = createMemorySessionStore()
  const booking = createBookingClient({ ...serverOptions, session, fetch })
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
  expect(await session.read()).toEqual({
    session: 'abcdefghijklmnopqrstuvwx',
    capabilities: { [reference]: capability },
  })
  const read = await booking.checkoutStatus(reference)
  expect(read.ok).toBe(true)
  // The website client asks for the guest portal link; Keyset's own booking site never does.
  expect(new URL(String(fetch.mock.calls[1]?.[0])).searchParams.get('include')).toBe('guestPortalUrl')
  expect(fetch.mock.calls[1]?.[1]?.headers.get('cookie')).toBe(
    `keyset_public_session=abcdefghijklmnopqrstuvwx; keyset_checkout_${reference}=${capability}`,
  )
  expect(fetch.mock.calls[1]?.[1]?.credentials).toBeUndefined()
})

it('the server client refuses a plain-HTTP API origin unless loopback HTTP is explicit', () => {
  expect(() =>
    createBookingClient({ apiBaseUrl: 'http://api.example', propertyId, session: createMemorySessionStore() }),
  ).toThrow('HTTPS origin')
  expect(() =>
    createBookingClient({
      apiBaseUrl: 'http://127.0.0.1:43101',
      propertyId,
      session: createMemorySessionStore(),
      allowLocalHttp: true,
    }),
  ).not.toThrow()
})

it('the server booking client cannot be built in a browser', () => {
  stubWindow({ location: { origin } })
  try {
    expect(() => createBookingClient({ ...serverOptions, session: createMemorySessionStore() })).toThrow(
      '@keyset/sdk/browser',
    )
    expect(() => createBookingRelay(relayOptions)).toThrow('requires a server')
  } finally {
    Reflect.deleteProperty(globalThis, 'window')
  }
})

function status(
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

it('P1-API-009: names each guest by an HMAC under the relay key, only when opted in and only on budgeted requests', async () => {
  const secretKey = `sk_test_ks1_${'a'.repeat(32)}_${'B'.repeat(43)}`
  const fetch = mock().mockImplementation(async () => Response.json({}))
  const search = (address: string) =>
    request('/search', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', 'x-client': address },
      body: '{}',
    })
  const sent = (call: number): Headers => fetch.mock.calls[call]?.[1]?.headers

  // Without the option nothing changes: no key, no guest, whatever the request carries.
  await createBookingRelay({ ...relayOptions, fetch })(search('198.51.100.7'))
  expect(sent(0).get('keyset-relay-key')).toBeNull()
  expect(sent(0).get('keyset-relay-guest')).toBeNull()

  const relay = createBookingRelay({
    ...relayOptions,
    fetch,
    relay: { secretKey, guest: (incoming) => incoming.headers.get('x-client') },
  })
  await relay(search('198.51.100.7'))
  await relay(search('198.51.100.7'))
  await relay(search('203.0.113.9'))
  await relay(request(''))
  const [first, again, other] = [sent(1), sent(2), sent(3)]
  expect(first.get('keyset-relay-key')).toBe(secretKey)
  expect(first.get('keyset-relay-guest')).toMatch(/^[a-f0-9]{64}$/)
  // Stable per guest, distinct between guests, and never the address itself.
  expect(again.get('keyset-relay-guest')).toBe(first.get('keyset-relay-guest'))
  expect(other.get('keyset-relay-guest')).not.toBe(first.get('keyset-relay-guest'))
  for (const headers of [first, other]) expect([...headers.values()].join(' ')).not.toMatch(/198\.51|203\.0/)
  // The property read is not budgeted, so the key does not travel with it.
  expect(sent(4).get('keyset-relay-key')).toBeNull()

  // A guest the relay cannot tell falls back to the shared budget; a malformed key fails at construction.
  await createBookingRelay({ ...relayOptions, fetch, relay: { secretKey, guest: () => null } })(search('x'))
  expect(sent(5).get('keyset-relay-key')).toBe(secretKey)
  expect(sent(5).get('keyset-relay-guest')).toBeNull()
  expect(() => createBookingRelay({ ...relayOptions, relay: { secretKey: 'pk_test_x', guest: () => null } })).toThrow(
    TypeError,
  )
})

/** Puts a stand-in `window` on the global object, as a browser would have one. */
function stubWindow(value: object): void {
  Object.defineProperty(globalThis, 'window', { value, configurable: true, writable: true })
}
