import type { MutationOptions, RequestOptions } from './client.js'
import { invalidRequest } from './result.js'
import { ROUTES, send, guard, type Wire } from './transport.js'
import { assertIdempotencyKey } from './validate.js'

export interface DeveloperProperty {
  readonly id: string
  readonly name: string
  readonly timezone: string
  readonly currency: string
  readonly units: readonly {
    readonly id: string
    readonly code: string
    readonly name: string
    readonly maxOccupancy: number
    readonly status: 'active' | 'inactive'
  }[]
}
export interface DeveloperReservation {
  readonly id: string
  readonly confirmationReference: string
  readonly source: 'manual'
  readonly paymentHandling: 'external'
  readonly createdAt: string
}
export interface DeveloperReservationRequest {
  readonly unitId: string
  readonly checkIn: string
  readonly checkOut: string
  readonly occupancy: { readonly adults: number; readonly children: number }
  readonly contact: { readonly firstName: string; readonly lastName: string; readonly email?: string | null }
  /** Agreed offline amount in integer minor units. This does not collect payment. */
  readonly agreedTotalMinor: string
  readonly currency: string
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid response')
  return Object.fromEntries(Object.entries(value))
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Invalid response')
  return value
}
function currency(value: unknown): string {
  const code = string(value)
  if (!/^[A-Z]{3}$/.test(code)) throw new TypeError('Invalid currency')
  return code
}
/** @public Loaded from dist by scripts/check-openapi-contract.mjs, which Knip cannot trace. */
export function parseDeveloperProperty(value: unknown): DeveloperProperty {
  const p = object(value)
  if (!Array.isArray(p['units'])) throw new TypeError('Invalid units')
  return {
    id: string(p['id']),
    name: string(p['name']),
    timezone: string(p['timezone']),
    currency: currency(p['currency']),
    units: p['units'].map((entry: unknown) => {
      const unit = object(entry)
      const status = unit['status']
      const maxOccupancy = unit['maxOccupancy']
      if (
        (status !== 'active' && status !== 'inactive') ||
        typeof maxOccupancy !== 'number' ||
        !Number.isSafeInteger(maxOccupancy)
      )
        throw new TypeError('Invalid unit')
      return { id: string(unit['id']), name: string(unit['name']), code: string(unit['code']), status, maxOccupancy }
    }),
  }
}
/** @public Loaded from dist by scripts/check-openapi-contract.mjs, which Knip cannot trace. */
export function parseDeveloperReservation(value: unknown): DeveloperReservation {
  const r = object(value)
  if (r['source'] !== 'manual' || r['paymentHandling'] !== 'external') throw new TypeError('Unknown Reservation state')
  return {
    id: string(r['id']),
    confirmationReference: string(r['confirmationReference']),
    source: r['source'],
    paymentHandling: r['paymentHandling'],
    createdAt: string(r['createdAt']),
  }
}

/** 0.3.0: one event of the public catalog (ADR-039), as a webhook delivers it. */
export type DeveloperEventType =
  | 'reservation.confirmed'
  | 'reservation.changed'
  | 'reservation.cancelled'
  | 'payment.received'
  | 'refund.succeeded'
  | 'refund.failed'
  | 'block.created'
  | 'block.released'
/** An event of a type this SDK version knows. `data` carries references, stay, apartment, counts and amounts in minor
 * units; never guest contact data. */
export interface KnownDeveloperEvent {
  readonly id: string
  readonly type: DeveloperEventType
  readonly createdAt: string
  readonly data: Readonly<Record<string, unknown>>
}
/** An event of a type this SDK version does not know yet; the server adds event types without a new major version.
 * The SDK did not parse it: `serverType` is the type the server sent, and `data` is raw, so treat it as untrusted
 * and unshaped. Skip it or handle it by `serverType`. */
export interface UnrecognizedDeveloperEvent {
  readonly id: string
  readonly type: 'unrecognized'
  readonly serverType: string
  readonly createdAt: string
  readonly data: Readonly<Record<string, unknown>>
}
/** Discriminated by `type`: `switch (event.type)` narrows, and `'unrecognized'` is the case for a newer server. */
export type DeveloperEvent = KnownDeveloperEvent | UnrecognizedDeveloperEvent
export interface DeveloperEventPage {
  readonly events: readonly DeveloperEvent[]
  /** More follow; ask again with `after` set to the last event's id. */
  readonly hasMore: boolean
}
const EVENT_TYPES = [
  'reservation.confirmed',
  'reservation.changed',
  'reservation.cancelled',
  'payment.received',
  'refund.succeeded',
  'refund.failed',
  'block.created',
  'block.released',
] as const
/** @public Loaded from dist by scripts/check-openapi-contract.mjs, which Knip cannot trace. */
export function parseDeveloperEvents(value: unknown): DeveloperEventPage {
  const page = object(value)
  if (!Array.isArray(page['events']) || typeof page['hasMore'] !== 'boolean') throw new TypeError('Invalid events')
  return {
    hasMore: page['hasMore'],
    events: page['events'].map((entry: unknown): DeveloperEvent => {
      const event = object(entry)
      const id = string(event['id'])
      if (!/^evt_[a-f0-9]{32}$/.test(id)) throw new TypeError('Invalid event id')
      const createdAt = string(event['createdAt'])
      const data = object(event['data'])
      const known = EVENT_TYPES.find((type) => type === event['type'])
      if (known) return { id, type: known, createdAt, data }
      const serverType = string(event['type'])
      if (serverType.length > 64 || !/^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/.test(serverType))
        throw new TypeError('Invalid event type')
      return { id, type: 'unrecognized', serverType, createdAt, data }
    }),
  }
}

export interface DeveloperBooking {
  readonly id: string
  readonly confirmationReference: string
  readonly source: 'manual' | 'direct' | 'import'
  /** `no_show` since 0.11: the guest never came; the apartment is free again, nothing was refunded. */
  readonly state: 'confirmed' | 'cancelled' | 'no_show'
  readonly unitId: string | null
  readonly checkIn: string
  readonly checkOut: string
}
export interface DeveloperCancellationPreview {
  readonly reservationId: string
  readonly version: string
  readonly source: 'manual' | 'direct'
  readonly paymentHandling: 'external' | 'keyset'
  readonly refundMinor: string | null
  readonly feeMinor: string | null
  readonly refundState: DeveloperCancellation['refundState']
  readonly currency: string
  readonly blocker: 'already_cancelled' | 'policy_missing' | 'payment_not_succeeded' | null
}
export interface DeveloperCancelRequest {
  readonly expectedVersion: string
  readonly expectedRefundMinor: string | null
  readonly reason: string
}
export interface DeveloperCancellation {
  readonly id: string
  readonly reservationVersion: string
  readonly cancelledAt: string
  readonly paymentHandling: 'external' | 'keyset'
  readonly refundState: 'requested' | 'processing' | 'unknown' | 'succeeded' | 'failed' | 'needs_attention' | null
}
function member<const T extends string>(value: unknown, choices: readonly T[]): T {
  for (const choice of choices) if (value === choice) return choice
  throw new TypeError('Unknown response state')
}
function nullableString(value: unknown): string | null {
  return value === null ? null : string(value)
}
/** @public Loaded from dist by scripts/check-openapi-contract.mjs, which Knip cannot trace. */
export function parseDeveloperBooking(value: unknown): DeveloperBooking {
  const r = object(value)
  return {
    id: string(r['id']),
    confirmationReference: string(r['confirmationReference']),
    source: member(r['source'], ['manual', 'direct', 'import']),
    state: member(r['state'], ['confirmed', 'cancelled', 'no_show']),
    unitId: nullableString(r['unitId']),
    checkIn: string(r['checkIn']),
    checkOut: string(r['checkOut']),
  }
}
/** @public Loaded from dist by scripts/check-openapi-contract.mjs, which Knip cannot trace. */
export function parseDeveloperCancellationPreview(value: unknown): DeveloperCancellationPreview {
  const r = object(value)
  return {
    reservationId: string(r['reservationId']),
    version: string(r['version']),
    source: member(r['source'], ['manual', 'direct']),
    paymentHandling: member(r['paymentHandling'], ['external', 'keyset']),
    refundMinor: nullableString(r['refundMinor']),
    feeMinor: nullableString(r['feeMinor']),
    refundState:
      r['refundState'] === null
        ? null
        : member(r['refundState'], ['requested', 'processing', 'unknown', 'succeeded', 'failed', 'needs_attention']),
    currency: currency(r['currency']),
    blocker:
      r['blocker'] === null
        ? null
        : member(r['blocker'], ['already_cancelled', 'policy_missing', 'payment_not_succeeded']),
  }
}
/** @public Loaded from dist by scripts/check-openapi-contract.mjs, which Knip cannot trace. */
export function parseDeveloperCancellation(value: unknown): DeveloperCancellation {
  const r = object(value)
  return {
    id: string(r['id']),
    reservationVersion: string(r['reservationVersion']),
    cancelledAt: string(r['cancelledAt']),
    paymentHandling: member(r['paymentHandling'], ['external', 'keyset']),
    refundState:
      r['refundState'] === null
        ? null
        : member(r['refundState'], ['requested', 'processing', 'unknown', 'succeeded', 'failed', 'needs_attention']),
  }
}

export interface KeysetOptions {
  readonly secretKey: string
  readonly apiBaseUrl: string
  readonly allowLocalHttp?: boolean
  readonly timeoutMs?: number
  readonly fetch?: typeof globalThis.fetch
}
function serverOnly() {
  if (typeof window !== 'undefined') throw new TypeError('Secret credentials require @keyset/sdk/server on a server')
}
/** A server credential is captured privately, never attached to the returned client or an error. */
export function createKeyset(options: KeysetOptions) {
  serverOnly()
  if (!/^sk_(test|live)_ks1_[a-f0-9]{32}_[A-Za-z0-9_-]{43}$/.test(options.secretKey))
    throw new TypeError('Invalid Keyset secret credential')
  const origin = new URL(options.apiBaseUrl)
  if (
    origin.origin !== options.apiBaseUrl ||
    origin.username ||
    origin.password ||
    (origin.protocol !== 'https:' &&
      !(
        options.allowLocalHttp &&
        origin.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
      ))
  )
    throw new TypeError('Expected an HTTPS API origin')
  if (origin.hostname === 'api-staging.keyset.cloud' && !options.secretKey.startsWith('sk_test_'))
    throw new TypeError('Staging requires a test credential')
  // 0.4.0: production also serves a business's test twin, whose keys are test keys.
  if (
    origin.hostname === 'api.keyset.cloud' &&
    !options.secretKey.startsWith('sk_live_') &&
    !options.secretKey.startsWith('sk_test_')
  )
    throw new TypeError('Production requires a live credential or a test twin credential')
  if (
    options.timeoutMs !== undefined &&
    (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 0 || options.timeoutMs > 2_147_483_647)
  )
    throw new TypeError('timeoutMs must be an integer between 0 and 2147483647')
  const secret = options.secretKey
  const fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  const wire: Wire = {
    origin: origin.origin,
    timeoutMs: options.timeoutMs ?? 15_000,
    fetch: async (input, init) => {
      serverOnly()
      const headers = new Headers(init?.headers)
      headers.set('authorization', `Bearer ${secret}`)
      return fetch(input, { ...init, headers, credentials: 'omit', redirect: 'error' })
    },
  }
  return {
    getProperty(propertyId: string, request: RequestOptions = {}) {
      if (!propertyValid(propertyId)) return Promise.resolve(invalidRequest('Invalid Property identifier'))
      return send(wire, {
        route: ROUTES.getDeveloperProperty,
        parameters: { propertyId },
        parse: parseDeveloperProperty,
        ...request,
      })
    },
    /** The settled events after `after` (an event id), oldest first; at most `limit` (1–100, default 50). */
    listEvents(
      propertyId: string,
      page: { readonly after?: string; readonly limit?: number; readonly type?: DeveloperEventType } = {},
      request: RequestOptions = {},
    ) {
      if (!propertyValid(propertyId)) return Promise.resolve(invalidRequest('Invalid Property identifier'))
      if (page.after !== undefined && !/^evt_[a-f0-9]{32}$/.test(page.after))
        return Promise.resolve(invalidRequest('Invalid event cursor'))
      if (page.limit !== undefined && (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 100))
        return Promise.resolve(invalidRequest('limit must be between 1 and 100'))
      return send(wire, {
        route: ROUTES.listDeveloperEvents,
        parameters: { propertyId },
        query: {
          ...(page.after ? { after: page.after } : {}),
          ...(page.limit ? { limit: String(page.limit) } : {}),
          ...(page.type ? { type: page.type } : {}),
        },
        parse: parseDeveloperEvents,
        ...request,
      })
    },
    getReservation(propertyId: string, reservationId: string, request: RequestOptions = {}) {
      if (!propertyValid(propertyId) || !propertyValid(reservationId))
        return Promise.resolve(invalidRequest('Invalid booking identifier'))
      return send(wire, {
        route: ROUTES.getDeveloperReservation,
        parameters: { propertyId, reservationId },
        parse: parseDeveloperBooking,
        ...request,
      })
    },
    previewCancellation(propertyId: string, reservationId: string, request: RequestOptions = {}) {
      if (!propertyValid(propertyId) || !propertyValid(reservationId))
        return Promise.resolve(invalidRequest('Invalid booking identifier'))
      return send(wire, {
        route: ROUTES.previewDeveloperCancellation,
        parameters: { propertyId, reservationId },
        parse: parseDeveloperCancellationPreview,
        ...request,
      })
    },
    /** Intrinsically idempotent resource transition; repeat the same version/refund decision after uncertainty. */
    cancelReservation(
      propertyId: string,
      reservationId: string,
      body: DeveloperCancelRequest,
      request: RequestOptions = {},
    ) {
      if (!propertyValid(propertyId) || !propertyValid(reservationId))
        return Promise.resolve(invalidRequest('Invalid booking identifier'))
      return send(wire, {
        route: ROUTES.cancelDeveloperReservation,
        parameters: { propertyId, reservationId },
        parse: parseDeveloperCancellation,
        body,
        ...request,
      })
    },
    createReservation(propertyId: string, body: DeveloperReservationRequest, request: MutationOptions) {
      const invalid = guard(() => assertIdempotencyKey(request.idempotencyKey))
      if (invalid) return Promise.resolve(invalid)
      if (!propertyValid(propertyId)) return Promise.resolve(invalidRequest('Invalid Property identifier'))
      return send(wire, {
        route: ROUTES.createDeveloperReservation,
        parameters: { propertyId },
        parse: parseDeveloperReservation,
        body,
        ...request,
      })
    },
  }
}

function propertyValid(propertyId: string) {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(propertyId)
}
