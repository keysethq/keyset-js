/**
 * The browser entrypoint. Two shapes.
 *
 * **Relay (recommended where you run a server).** The client talks to **your own origin**, never to Keyset directly.
 *
 * Mount `createBookingRelay` from `@keyset/sdk/server` at `/public/*` on your website and point this client at that
 * website's origin. The relay keeps the guest's session and checkout capability in host-only `HttpOnly` cookies your
 * page cannot read, so a cross-site script cannot lift them, and it never forwards a browser identity assertion or an
 * API credential upstream.
 *
 * ```ts
 * import { createBookingClient } from '@keyset/sdk/browser'
 *
 * const booking = createBookingClient({ websiteOrigin: window.location.origin, propertyId: 'public_property_...' })
 * const offers = await booking.searchAvailability({ checkIn: '2027-02-01', checkOut: '2027-02-03', occupancy: { adults: 2, children: 0 } })
 * if (!offers.ok) return show(offers.error)
 * ```
 *
 * **Direct with a publishable key (0.4.0).** Without a server of your own, the page calls Keyset itself with the
 * publishable key the host created for this website's origin in Keyset (Einstellungen › API-Schlüssel). The guest's
 * session and a checkout's capability are then held in this tab's session storage — the capability reads that one
 * checkout, like a payment provider's client secret — and sent in headers; the browser sends no cookies to Keyset.
 *
 * ```ts
 * const booking = createBookingClient({ publishableKey: 'pk_test_…', apiOrigin: 'https://api-staging.keyset.cloud', propertyId: 'public_property_...' })
 * ```
 */
import { createClient, type BookingClient } from './client.js'
import { createBrowserSessionStore, type BookingSessionStore } from './session.js'

export interface BrowserRelayClientOptions {
  /**
   * The origin of the website serving the relay — normally `window.location.origin`. It must be an origin with no
   * path, query, fragment or credentials, and in a browser it must equal the page's own origin.
   */
  readonly websiteOrigin: string
  /** The public property identifier Keyset issued for this booking page. */
  readonly propertyId: string
  /** Injected only by tests. Defaults to the platform `fetch`. */
  readonly fetch?: typeof globalThis.fetch
}

/** 0.4.0: calling Keyset directly from the page with a publishable key. */
export interface BrowserDirectClientOptions {
  /** `pk_test_…` or `pk_live_…`, created for this website's origin. Not a secret. */
  readonly publishableKey: string
  /** The Keyset API origin, `https://api-staging.keyset.cloud` for test; loopback `http` only for development. */
  readonly apiOrigin: string
  /** The public property identifier Keyset issued for this booking page. */
  readonly propertyId: string
  /** Where the session and capabilities are kept. Defaults to this tab's session storage. */
  readonly session?: BookingSessionStore
  /** Injected only by tests. Defaults to the platform `fetch`. */
  readonly fetch?: typeof globalThis.fetch
}

export type BrowserBookingClientOptions = BrowserRelayClientOptions | BrowserDirectClientOptions

function websiteOrigin(value: string): string {
  const url = new URL(value)
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new TypeError('Expected a website origin')
  if (typeof window !== 'undefined' && url.origin !== window.location.origin)
    throw new TypeError('The booking client must use the website origin')
  return url.origin
}

function apiOrigin(value: string): string {
  const url = new URL(value)
  if (
    url.origin !== value ||
    url.username ||
    url.password ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  )
    throw new TypeError('Expected an HTTPS API origin')
  return url.origin
}

/**
 * A booking client for the browser.
 *
 * Throws `TypeError` on a misconfigured origin, key or property reference, because those are programming mistakes
 * rather than runtime conditions. Every call afterwards returns a `BookingResult` and never throws.
 */
export function createBookingClient(options: BrowserBookingClientOptions): BookingClient {
  if (!/^[A-Za-z0-9_-]{22,64}$/.test(options.propertyId)) throw new TypeError('Expected a public property identifier')
  const fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  if ('publishableKey' in options) {
    if (!/^pk_(test|live)_[A-Za-z0-9]{24}$/.test(options.publishableKey))
      throw new TypeError('Expected a publishable key')
    return createClient(
      {
        origin: apiOrigin(options.apiOrigin),
        fetch,
        direct: {
          publishableKey: options.publishableKey,
          store: options.session ?? createBrowserSessionStore(options.propertyId),
        },
      },
      options.propertyId,
    )
  }
  return createClient({ origin: websiteOrigin(options.websiteOrigin), fetch }, options.propertyId)
}

export { createBrowserSessionStore, type BookingSessionState, type BookingSessionStore } from './session.js'
