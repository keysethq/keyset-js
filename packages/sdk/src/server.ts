/**
 * The server entrypoint. Two independent tools; most integrations need only the first.
 *
 * `createBookingRelay` is the recommended shape for a guest-facing website. Your browser code talks to your own
 * origin, your server forwards a narrow allowlist of booking requests to Keyset, and the guest's session and checkout
 * capability live in host-only `HttpOnly` cookies your page cannot read. No browser identity assertion ever leaves
 * your server, and no API credential unless you opt into `relay` — then your secret key goes to Keyset alone, so that
 * each of your guests gets their own request budget.
 *
 * `createBookingClient` is for server-side booking without a browser: an internal tool, a server-rendered flow, a
 * job. It holds the guest's capability itself, so it needs an explicit store — see `BookingSessionStore`.
 *
 * ```ts
 * import { createBookingClient, createBookingRelay, createMemorySessionStore } from '@keyset/sdk/server'
 *
 * // Website relay, mounted unchanged at /public/*
 * const relay = createBookingRelay({ websiteOrigin: 'https://example.com', apiOrigin: 'https://api-staging.keyset.cloud', propertyId })
 *
 * // Direct server client. One store per guest session, never one shared store for every guest.
 * const booking = createBookingClient({ apiBaseUrl: 'https://api-staging.keyset.cloud', propertyId, session: createMemorySessionStore() })
 * ```
 */
import { createClient, type BookingClient } from './client.js'
import type { BookingSessionStore } from './session.js'
import type { Wire } from './transport.js'
import { assertReference, parseCheckout } from './validate.js'

const SESSION_COOKIE = 'keyset_public_session'
const CHECKOUT_COOKIE = /^keyset_checkout_([A-Za-z0-9_-]{22,64})$/
const COOKIE_VALUE = /^[A-Za-z0-9_-]{22,128}$/

function origin(value: string, allowLocalHttp: boolean): URL {
  const url = new URL(value)
  if (
    url.origin !== value ||
    url.username ||
    url.password ||
    (url.protocol !== 'https:' &&
      !(allowLocalHttp && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
  )
    throw new TypeError('Expected an HTTPS origin (or explicitly enabled loopback HTTP)')
  return url
}

export interface ServerBookingClientOptions {
  /** The Keyset API origin. Staging is `https://api-staging.keyset.cloud`; production is not active. */
  readonly apiBaseUrl: string
  /** The public property identifier Keyset issued for this booking page. */
  readonly propertyId: string
  /** Where this guest's session and checkout capabilities live. One store per guest session. */
  readonly session: BookingSessionStore
  /** Explicit loopback-only HTTP for local development. Production is always HTTPS. */
  readonly allowLocalHttp?: boolean
  /** Milliseconds before a request is abandoned. Default 15000. A mutation that times out is an unknown outcome. */
  readonly timeoutMs?: number
  /** Injected only by tests. Defaults to the platform `fetch`. */
  readonly fetch?: typeof globalThis.fetch
}

/**
 * A booking client for a server.
 *
 * Throws `TypeError` on a misconfigured origin or property reference. Every call afterwards returns a
 * `BookingResult` and never throws.
 */
export function createBookingClient(options: ServerBookingClientOptions): BookingClient {
  if (typeof window !== 'undefined')
    throw new TypeError('The server booking client must not run in a browser; use @keyset/sdk/browser')
  const api = origin(options.apiBaseUrl, options.allowLocalHttp === true)
  assertReference(options.propertyId, 'propertyId')
  const store = options.session
  const wire: Wire = {
    origin: api.origin,
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    timeoutMs: options.timeoutMs ?? 15_000,
    cookies: {
      read: async (checkoutReference) => {
        const state = await store.read()
        const pairs: string[] = []
        if (state.session) pairs.push(`${SESSION_COOKIE}=${state.session}`)
        const capability = checkoutReference ? state.capabilities[checkoutReference] : undefined
        if (checkoutReference && capability) pairs.push(`keyset_checkout_${checkoutReference}=${capability}`)
        return pairs.length ? pairs.join('; ') : undefined
      },
      write: async (setCookies) => {
        const state = await store.read()
        let session = state.session
        const capabilities: Record<string, string> = { ...state.capabilities }
        let changed = false
        for (const raw of setCookies) {
          const pair = raw.split(';', 1)[0]?.trim() ?? ''
          const separator = pair.indexOf('=')
          if (separator <= 0) continue
          const name = pair.slice(0, separator)
          const value = pair.slice(separator + 1)
          if (!COOKIE_VALUE.test(value)) continue
          if (name === SESSION_COOKIE) {
            session = value
            changed = true
            continue
          }
          const checkout = CHECKOUT_COOKIE.exec(name)?.[1]
          if (checkout) {
            capabilities[checkout] = value
            changed = true
          }
        }
        if (changed) await store.write({ ...(session ? { session } : {}), capabilities })
      },
    },
  }
  return createClient(wire, options.propertyId)
}

export interface BookingRelayOptions {
  /** Your website's own origin. Requests must arrive here and nowhere else. */
  readonly websiteOrigin: string
  /** The Keyset API origin the relay forwards to. */
  readonly apiOrigin: string
  /** The public property identifier this relay serves. One relay serves exactly one property. */
  readonly propertyId: string
  /** Explicit loopback-only HTTP development. Production cookies are always Secure. */
  readonly allowLocalHttp?: boolean
  readonly fetch?: typeof globalThis.fetch
  /**
   * Opt-in: give every guest of your website their own request budget. See {@link BookingRelayGuests}. Without it,
   * all guests of the relay share one budget, as Keyset sees them all arrive from your server's address.
   */
  readonly relay?: BookingRelayGuests
}

/**
 * Lets Keyset count each guest of your website on their own instead of your server as one visitor.
 *
 * Keyset budgets searches, calendar reads, quotes and checkouts per source (for example 30 searches per five minutes).
 * Behind a relay every guest arrives from your server, so on a busy day real guests share — and exhaust — one budget.
 * With this option the relay proves with a secret key that it acts for your business and names the guest of each
 * request, and each guest gets their own budget. All guests a relay names for one booking page share a ceiling of
 * 300 budgeted requests per five minutes, so a leaked key can never multiply your page's capacity.
 *
 * ```ts
 * const relay = createBookingRelay({
 *   websiteOrigin, apiOrigin, propertyId,
 *   // `clientAddress` stands for however your platform exposes the visitor's address from your own trusted proxy.
 *   relay: { secretKey: process.env.KEYSET_RELAY_KEY ?? '', guest: (request) => clientAddress(request) },
 * })
 * ```
 */
export interface BookingRelayGuests {
  /**
   * A secret key (`sk_test_ks1_…`/`sk_live_ks1_…`) of this business whose service may read the Property, created under
   * Settings > Developers > Keys with the template „Website mit eigenem Server“. Keep it in your server's secret
   * store; it is sent only to Keyset and only from your server.
   */
  readonly secretKey: string
  /**
   * The guest a request comes from, as your platform resolves it — usually the client address your own trusted
   * proxy reports. Return `null` when you cannot tell; that request then counts against the relay's shared budget.
   * Never return a header a visitor can set unchecked: whoever controls it chooses their own budget (bounded by the
   * ceiling). The value never leaves your server — the relay sends only an HMAC of it under your secret key.
   */
  readonly guest: (request: Request) => string | null | undefined | Promise<string | null | undefined>
}

const RELAY_KEY = /^sk_(test|live)_ks1_[a-f0-9]{32}_[A-Za-z0-9_-]{43}$/

/** HMAC-SHA-256 of the guest under the relay's own secret key, as hex: a stable bucket name Keyset cannot reverse. */
async function guestName(secretKey: string, guest: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(secretKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = new Uint8Array(
    await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(`keyset-relay-guest:v1:${guest}`)),
  )
  return Array.from(mac, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function refusal(status: number) {
  return Response.json(
    {
      type: 'about:blank',
      title: 'Booking unavailable',
      status,
      code: status >= 500 ? 'SERVICE_UNAVAILABLE' : 'INVALID_BOOKING_DETAILS',
      retryable: status >= 500,
    },
    { status, headers: { 'cache-control': 'private, no-store', 'content-type': 'application/problem+json' } },
  )
}

/**
 * The availability calendar is the one relayed request with a query string. Exactly its four parameters, each once,
 * as a calendar day or plain digits, and since 0.12.0 optionally a fifth, `publicUnitReference`, as a public
 * reference; the query is rebuilt from them rather than passed through, so nothing else can ride along to Keyset.
 * Bounds stay the API's decision.
 */
function calendarQuery(parameters: URLSearchParams): string | null {
  const names = [...parameters.keys()]
  const unit = parameters.get('publicUnitReference')
  const expected = unit === null ? 4 : 5
  if (names.length !== expected || new Set(names).size !== expected) return null
  const from = parameters.get('from')
  const nights = parameters.get('nights')
  const adults = parameters.get('adults')
  const children = parameters.get('children')
  if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !nights || !adults || !children) return null
  if (![nights, adults, children].every((value) => /^\d{1,3}$/.test(value))) return null
  if (unit !== null && !/^[A-Za-z0-9_-]{22,64}$/.test(unit)) return null
  return `?${new URLSearchParams({ from, nights, adults, children, ...(unit === null ? {} : { publicUnitReference: unit }) }).toString()}`
}

/** Since 0.12.0 the checkout status may ask for the guest portal link; nothing else rides along. */
function statusQuery(parameters: URLSearchParams): string | null {
  const names = [...parameters.keys()]
  if (names.length === 0) return ''
  if (names.length !== 1 || parameters.get('include') !== 'guestPortalUrl') return null
  return '?include=guestPortalUrl'
}

function cookies(raw: string | null, reference?: string) {
  return (raw ?? '')
    .split(';')
    .map((value) => value.trim())
    .filter((value) => {
      const match = /^(keyset_public_session|keyset_checkout_[A-Za-z0-9_-]{22,64})=([A-Za-z0-9_-]{22,128})$/.exec(value)
      return match && (match[1] === SESSION_COOKIE || match[1] === `keyset_checkout_${reference}`)
    })
    .join('; ')
}

/**
 * A same-origin booking relay. Mount the returned handler unchanged at `/public/*` on your website.
 *
 * What it guarantees, and why each guarantee exists:
 *
 * - only seven paths and two methods reach Keyset; anything else is a 404 that reveals nothing. Only the
 *   availability calendar carries a query, rebuilt from exactly its validated parameters, and the checkout status
 *   the one `include=guestPortalUrl`.
 * - a write must carry your exact `Origin`, and a `Sec-Fetch-Site` that is same-origin or none, so another site
 *   cannot make a guest's browser book through your relay.
 * - the request body is read with a hard 16 KiB streaming bound, so a chunked body cannot exhaust your server.
 * - only validated `origin`, `accept`, `content-type` and `idempotency-key` are forwarded. No browser identity
 *   assertion, forwarding header or API credential is passed upstream, and the relay never invents a client address.
 * - with the opt-in `relay` option, and only then, the four budgeted requests (search, calendar, quote, checkout) also
 *   carry your secret key and an HMAC of the guest your `guest` function names, so each guest gets their own budget.
 *   The guest value itself, such as an address, never leaves your server. A key Keyset refuses answers 403.
 * - only Keyset's own session and matching checkout cookies are forwarded, in each direction. They are re-issued as
 *   host-only, `HttpOnly`, `SameSite=Lax`, path-scoped and `Secure` on HTTPS, so your page cannot read them.
 * - an upstream redirect is refused rather than followed, and every response is `private, no-store`.
 */
export function createBookingRelay(options: BookingRelayOptions): (request: Request) => Promise<Response> {
  if (typeof window !== 'undefined') throw new TypeError('The booking relay requires a server')
  const website = origin(options.websiteOrigin, options.allowLocalHttp === true)
  const api = origin(options.apiOrigin, options.allowLocalHttp === true)
  assertReference(options.propertyId, 'propertyId')
  const property = options.propertyId
  const transport = options.fetch ?? globalThis.fetch
  const guests = options.relay
  if (guests && (!RELAY_KEY.test(guests.secretKey) || typeof guests.guest !== 'function'))
    throw new TypeError('relay needs a secret key (sk_test_ks1_… or sk_live_ks1_…) and a guest function')
  return async (request) => {
    const url = new URL(request.url)
    const propertyPath = `/public/booking-properties/${property}`
    const read = request.method === 'GET'
    const write = request.method === 'POST'
    const checkoutMatch = /^\/public\/checkouts\/([A-Za-z0-9_-]{22,64})(\/payment-session)?$/.exec(url.pathname)
    const reference = checkoutMatch?.[1]
    const propertyRead = read && url.pathname === propertyPath
    const calendarRead = read && url.pathname === `${propertyPath}/availability`
    // The checkout status takes one query, `include=guestPortalUrl`, and only exactly that.
    const statusRead = read && checkoutMatch !== null && checkoutMatch[2] === undefined
    const propertyWrite =
      write && ['search', 'quotes', 'checkouts'].some((action) => url.pathname === `${propertyPath}/${action}`)
    if (
      url.origin !== website.origin ||
      (url.search && !calendarRead && !statusRead) ||
      !(propertyRead || calendarRead || propertyWrite || (read && checkoutMatch))
    )
      return refusal(404)
    const query = calendarRead ? calendarQuery(url.searchParams) : statusRead ? statusQuery(url.searchParams) : ''
    if (query === null) return refusal(422)
    const requestOrigin = request.headers.get('origin')
    const fetchSite = request.headers.get('sec-fetch-site')
    if (
      (requestOrigin !== null && requestOrigin !== website.origin) ||
      (write && requestOrigin !== website.origin) ||
      (fetchSite !== null && !['same-origin', 'none'].includes(fetchSite))
    )
      return refusal(403)
    if (write && request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
      return refusal(415)
    // Streaming bound also covers chunked bodies; Content-Length alone is not authoritative.
    let body: string | undefined
    if (write) {
      const reader = request.body?.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      if (reader) {
        try {
          for (;;) {
            const part = await reader.read()
            if (part.done) break
            size += part.value.byteLength
            if (size > 16_384) {
              await reader.cancel()
              return refusal(413)
            }
            chunks.push(part.value)
          }
        } catch {
          return refusal(400)
        }
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      body = new TextDecoder().decode(bytes)
    }
    const headers = new Headers()
    for (const name of ['accept', 'content-type', 'idempotency-key']) {
      const value = request.headers.get(name)
      if (value) headers.set(name, value)
    }
    if (requestOrigin) headers.set('origin', requestOrigin)
    const selected = cookies(request.headers.get('cookie'), reference)
    if (selected) headers.set('cookie', selected)
    if (guests && (calendarRead || propertyWrite)) {
      headers.set('keyset-relay-key', guests.secretKey)
      let guest: string | null | undefined
      try {
        guest = await guests.guest(request)
      } catch {
        guest = null
      }
      if (typeof guest === 'string' && guest.length > 0)
        headers.set('keyset-relay-guest', await guestName(guests.secretKey, guest))
    }
    // Origin is validated here, not invented from Host/X-Forwarded-Host. API source budgets use the real peer.
    let upstream: Response
    try {
      upstream = await transport(new URL(`${url.pathname}${query}`, api), {
        method: request.method,
        headers,
        ...(body !== undefined ? { body } : {}),
        redirect: 'manual',
        cache: 'no-store',
        signal: AbortSignal.timeout(15_000),
      })
    } catch {
      return refusal(503)
    }
    if (upstream.status >= 300 && upstream.status < 400) return refusal(502)
    let payload: string
    try {
      payload = await upstream.text()
    } catch {
      return refusal(502)
    }
    let responseReference = reference
    if (url.pathname === `${propertyPath}/checkouts` && upstream.status === 201) {
      try {
        const raw: unknown = JSON.parse(payload)
        responseReference = parseCheckout(raw).publicCheckoutReference
      } catch {
        return refusal(502)
      }
    }
    const out = new Headers({ 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' })
    for (const name of ['content-type', 'retry-after', 'x-request-id']) {
      const value = upstream.headers.get(name)
      if (value) out.set(name, value)
    }
    for (const cookie of upstream.headers.getSetCookie()) {
      const pair = cookie.split(';')[0] ?? ''
      if (!cookies(pair, responseReference)) continue
      const session = pair.startsWith(`${SESSION_COOKIE}=`)
      out.append(
        'set-cookie',
        `${pair}; Path=${session ? '/public' : '/public/checkouts'}; HttpOnly; SameSite=Lax${website.protocol === 'https:' ? '; Secure' : ''}; Max-Age=${session ? '86400' : '2592000'}`,
      )
    }
    return new Response(payload, { status: upstream.status, headers: out })
  }
}
export { createKeyset } from './developer.js'
export type {
  KeysetOptions,
  DeveloperProperty,
  DeveloperReservation,
  DeveloperReservationRequest,
  DeveloperBooking,
  DeveloperEvent,
  DeveloperEventPage,
  DeveloperEventType,
  KnownDeveloperEvent,
  UnrecognizedDeveloperEvent,
  DeveloperCancellation,
  DeveloperCancellationPreview,
  DeveloperCancelRequest,
} from './developer.js'

export { createMemorySessionStore, type BookingSessionState, type BookingSessionStore } from './session.js'
