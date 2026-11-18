/**
 * The one place the SDK speaks HTTP.
 *
 * Every public route is declared once, here, as a method plus a path template plus whether it mutates and whether it
 * requires an idempotency key. `scripts/check-openapi-contract.mjs` reads this table and fails the build when it
 * stops matching the published OpenAPI document, so the SDK cannot silently drift from the wire contract.
 */
import { invalidRequest, recoveryFor, type BookingResult } from './result.js'
import type { BookingSessionStore } from './session.js'
import { readProblem, ShapeError } from './validate.js'

export interface RouteDeclaration {
  readonly method: 'GET' | 'POST'
  readonly path: string
  readonly mutation: boolean
  readonly idempotent: boolean
}

/** The complete supported external surface. Nothing else is a public Keyset route. */
export const ROUTES = {
  getDeveloperReservation: {
    method: 'GET',
    path: '/v1/properties/{propertyId}/reservations/{reservationId}',
    mutation: false,
    idempotent: false,
  },
  previewDeveloperCancellation: {
    method: 'GET',
    path: '/v1/properties/{propertyId}/reservations/{reservationId}/cancellation-preview',
    mutation: false,
    idempotent: false,
  },
  cancelDeveloperReservation: {
    method: 'POST',
    path: '/v1/properties/{propertyId}/reservations/{reservationId}/cancel',
    mutation: true,
    idempotent: false,
  },
  getDeveloperProperty: { method: 'GET', path: '/v1/properties/{propertyId}', mutation: false, idempotent: false },
  listDeveloperEvents: {
    method: 'GET',
    path: '/v1/properties/{propertyId}/events',
    mutation: false,
    idempotent: false,
  },
  createDeveloperReservation: {
    method: 'POST',
    path: '/v1/properties/{propertyId}/reservations',
    mutation: true,
    idempotent: true,
  },
  getBookingProperty: {
    method: 'GET',
    path: '/public/booking-properties/{publicPropertyId}',
    mutation: false,
    idempotent: false,
  },
  readAvailabilityCalendar: {
    method: 'GET',
    path: '/public/booking-properties/{publicPropertyId}/availability',
    mutation: false,
    idempotent: false,
  },
  searchAvailability: {
    method: 'POST',
    path: '/public/booking-properties/{publicPropertyId}/search',
    mutation: false,
    idempotent: false,
  },
  createQuote: {
    method: 'POST',
    path: '/public/booking-properties/{publicPropertyId}/quotes',
    mutation: true,
    idempotent: true,
  },
  startCheckout: {
    method: 'POST',
    path: '/public/booking-properties/{publicPropertyId}/checkouts',
    mutation: true,
    idempotent: true,
  },
  readCheckoutStatus: {
    method: 'GET',
    path: '/public/checkouts/{publicCheckoutReference}',
    mutation: false,
    idempotent: false,
  },
  readPaymentSession: {
    method: 'GET',
    path: '/public/checkouts/{publicCheckoutReference}/payment-session',
    mutation: false,
    idempotent: false,
  },
} as const satisfies Record<string, RouteDeclaration>

/**
 * How cookies cross the boundary. In a browser the platform owns the jar and this is absent; on a server the caller
 * owns it, because a checkout capability is bearer-equivalent and its storage is the integrator's decision.
 */
interface CookieBridge {
  read(checkoutReference: string | undefined): Promise<string | undefined>
  write(setCookies: readonly string[]): Promise<void>
}

/**
 * 0.4.0, a browser calling Keyset directly with a publishable key: the key names the business, and the session and a
 * checkout's capability travel in headers the page keeps in its store, because a cross-site browser sends no cookies.
 */
interface DirectBridge {
  readonly publishableKey: string
  readonly store: BookingSessionStore
}

export interface Wire {
  /** Absolute origin without a trailing slash. */
  readonly origin: string
  readonly fetch: typeof globalThis.fetch
  /** Present on a server, absent in a browser where the platform cookie jar is used. */
  readonly cookies?: CookieBridge
  /** Present in the browser's direct mode, which sends no cookies at all. */
  readonly direct?: DirectBridge
  /** Milliseconds after which a request is abandoned. A mutation that times out is an unknown outcome. */
  readonly timeoutMs?: number
}

export interface Call<T> {
  readonly route: RouteDeclaration
  readonly parameters: Readonly<Record<string, string>>
  /** Query-string values, in the order given. Only reads carry a query. */
  readonly query?: Readonly<Record<string, string>>
  readonly parse: (value: unknown) => T
  readonly body?: unknown
  readonly idempotencyKey?: string
  readonly signal?: AbortSignal
  /** Set for the checkout-scoped reads, so a server bridge sends only the matching capability. */
  readonly checkoutReference?: string
}

function expand(route: RouteDeclaration, parameters: Readonly<Record<string, string>>): string {
  return route.path.replaceAll(/\{([A-Za-z]+)\}/g, (_match, name: string) => {
    const value = parameters[name]
    if (value === undefined) throw new TypeError(`Missing path parameter ${name}`)
    return encodeURIComponent(value)
  })
}

function combine(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  if (timeoutMs === undefined) return signal
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

const DIRECT_TOKEN = /^[A-Za-z0-9_-]{22,128}$/

/** What a direct call's answer hands the page to keep: a new session, and a started checkout's capability. */
async function keepDirectState(store: BookingSessionStore, headers: Headers, payload: unknown) {
  const sessionHeader = headers.get('keyset-session')
  const session = sessionHeader !== null && DIRECT_TOKEN.test(sessionHeader) ? sessionHeader : undefined
  const capabilityHeader = headers.get('keyset-checkout-capability')
  const referenceValue: unknown =
    typeof payload === 'object' && payload !== null ? Reflect.get(payload, 'publicCheckoutReference') : undefined
  const reference =
    typeof referenceValue === 'string' && /^[A-Za-z0-9_-]{22,64}$/.test(referenceValue) ? referenceValue : undefined
  const capability =
    capabilityHeader !== null && DIRECT_TOKEN.test(capabilityHeader) && reference ? capabilityHeader : undefined
  if (!session && !capability) return
  const state = await store.read()
  const kept = session ?? state.session
  await store.write({
    ...(kept ? { session: kept } : {}),
    capabilities: capability && reference ? { ...state.capabilities, [reference]: capability } : state.capabilities,
  })
}

/**
 * Dispatch one call and classify the answer.
 *
 * The classification is the safety-critical part. A problem document becomes a typed `api` failure with the safe
 * recovery for its code. Anything else — a lost connection, an abort, a body that does not validate — becomes
 * `outcome_unknown` for a mutation and `transport` for a read, because after a mutation leaves the process the SDK
 * can no longer prove it was not applied.
 */
export async function send<T>(wire: Wire, call: Call<T>): Promise<BookingResult<T>> {
  const search = call.query ? `?${new URLSearchParams(Object.entries(call.query)).toString()}` : ''
  const url = `${wire.origin}${expand(call.route, call.parameters)}${search}`
  const headers = new Headers({ accept: 'application/json' })
  if (call.body !== undefined) headers.set('content-type', 'application/json')
  if (call.idempotencyKey !== undefined) headers.set('idempotency-key', call.idempotencyKey)
  if (wire.cookies) {
    const cookie = await wire.cookies.read(call.checkoutReference)
    if (cookie) headers.set('cookie', cookie)
  }
  if (wire.direct) {
    const state = await wire.direct.store.read()
    headers.set('keyset-publishable-key', wire.direct.publishableKey)
    if (state.session) headers.set('keyset-session', state.session)
    const capability = call.checkoutReference ? state.capabilities[call.checkoutReference] : undefined
    if (capability) headers.set('keyset-checkout-capability', capability)
  }
  const signal = combine(call.signal, wire.timeoutMs)
  let response: Response
  try {
    response = await wire.fetch(url, {
      method: call.route.method,
      headers,
      ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
      ...(wire.cookies ? {} : { credentials: wire.direct ? ('omit' as const) : ('include' as const) }),
      cache: 'no-store',
      redirect: 'error',
      ...(signal ? { signal } : {}),
    })
  } catch {
    return lost(call.route.mutation, 'The request did not complete.')
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return lost(call.route.mutation, `The response body was not JSON (HTTP ${response.status}).`)
  }
  if (!response.ok) {
    const problem = readProblem(payload)
    if (!problem) return lost(call.route.mutation, `HTTP ${response.status} carried no problem document.`)
    const requestId = response.headers.get('x-request-id')
    return {
      ok: false,
      error: {
        kind: 'api',
        problem,
        recovery: recoveryFor(problem.code, call.route.mutation, problem.retryable),
        ...(requestId ? { requestId } : {}),
      },
    }
  }
  if (wire.cookies) await wire.cookies.write(response.headers.getSetCookie())
  if (wire.direct) await keepDirectState(wire.direct.store, response.headers, payload)
  try {
    return { ok: true, value: call.parse(payload) }
  } catch (error) {
    const detail = error instanceof ShapeError ? error.message : 'The response did not match the contract.'
    return lost(call.route.mutation, detail)
  }
}

function lost(mutation: boolean, message: string): BookingResult<never> {
  return mutation
    ? { ok: false, error: { kind: 'outcome_unknown', recovery: 'retry_same_request', message } }
    : { ok: false, error: { kind: 'transport', recovery: 'retry_read', message } }
}

/** Turn a local shape violation into an `invalid_request` result rather than a thrown error. */
export function guard(check: () => void): BookingResult<never> | undefined {
  try {
    check()
    return undefined
  } catch (error) {
    return error instanceof ShapeError
      ? invalidRequest(error.message, error.path)
      : invalidRequest(error instanceof Error ? error.message : 'The request is not valid.')
  }
}
