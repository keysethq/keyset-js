import { type EventType, eventType } from './events.js'

/**
 * The few Keyset routes the CLI calls. Every answer is parsed before it is used; anything that does not have the
 * expected shape is `malformed`, never guessed at. Nothing here prints, and no failure carries a request body.
 */
export type Fetch = (input: string, init: RequestInit) => Promise<Response>

export type ApiFailure =
  | {
      readonly kind: 'problem'
      readonly status: number
      /** The problem's `code`, when the answer was a Keyset problem document. */
      readonly code: string | null
      readonly retryAfterSeconds: number | null
    }
  | { readonly kind: 'network'; readonly reason: string }
  | { readonly kind: 'malformed'; readonly status: number }

export type ApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ApiFailure }

export interface PairingStarted {
  readonly pairingSecret: string
  readonly userCode: string
  readonly verificationUrl: string
  readonly expiresAt: string
  readonly intervalSeconds: number
}

export type PairingCollected =
  | { readonly status: 'pending' }
  | {
      readonly status: 'approved'
      readonly sealedKey: string
      readonly propertyId: string
      readonly propertyName: string
      readonly test: boolean
    }

export interface KeysetEvent {
  readonly id: string
  readonly type: EventType
  readonly createdAt: string
  readonly data: Readonly<Record<string, unknown>>
}

interface EventPage {
  readonly events: readonly KeysetEvent[]
  readonly hasMore: boolean
}

const EVENT_ID = /^evt_[a-f0-9]{32}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null
}

/** The envelope's `createdAt` is `toISOString()` of the instant; normalise so a forwarded body matches a delivery. */
function instant(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
}

function parseEvent(value: unknown): KeysetEvent | null {
  const event = record(value)
  if (!event) return null
  const type = eventType(event['type'])
  const createdAt = instant(event['createdAt'])
  const data = record(event['data'])
  const id = event['id']
  if (typeof id !== 'string' || !EVENT_ID.test(id) || !type || !createdAt || !data) return null
  return { id, type, createdAt, data }
}

function parseEventPage(value: unknown): EventPage | null {
  const page = record(value)
  if (!page || !Array.isArray(page['events']) || typeof page['hasMore'] !== 'boolean') return null
  const events: KeysetEvent[] = []
  for (const entry of page['events']) {
    const event = parseEvent(entry)
    if (!event) return null
    events.push(event)
  }
  return { events, hasMore: page['hasMore'] }
}

function parseStarted(value: unknown): PairingStarted | null {
  const body = record(value)
  if (!body) return null
  const { pairingSecret, userCode, verificationUrl, expiresAt, intervalSeconds } = body
  if (typeof pairingSecret !== 'string' || !/^kcp_[A-Za-z0-9_-]{43}$/.test(pairingSecret)) return null
  if (typeof userCode !== 'string' || !/^[A-Z]{4}-[A-Z]{4}$/.test(userCode)) return null
  if (typeof verificationUrl !== 'string' || typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt)))
    return null
  if (typeof intervalSeconds !== 'number' || !Number.isInteger(intervalSeconds) || intervalSeconds < 1) return null
  return { pairingSecret, userCode, verificationUrl, expiresAt, intervalSeconds: Math.min(intervalSeconds, 30) }
}

function parseCollected(value: unknown): PairingCollected | null {
  const body = record(value)
  if (!body) return null
  if (body['status'] === 'pending') return { status: 'pending' }
  const { status, sealedKey, propertyId, propertyName, test } = body
  if (status !== 'approved' || typeof sealedKey !== 'string' || typeof propertyName !== 'string') return null
  if (typeof propertyId !== 'string' || !UUID.test(propertyId) || typeof test !== 'boolean') return null
  return { status, sealedKey, propertyId, propertyName, test }
}

function parseTestEvent(value: unknown): { readonly id: string; readonly type: EventType } | null {
  const body = record(value)
  const type = eventType(body?.['type'])
  const id = body?.['id']
  return typeof id === 'string' && EVENT_ID.test(id) && type ? { id, type } : null
}

/** A connection failure in words a developer recognises: the system code where Node has one. */
export function describeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return 'timed out'
    const cause: unknown = error.cause
    if (cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string') return cause.code
    return error.message
  }
  return 'connection failed'
}

function retryAfter(response: Response): number | null {
  const value = response.headers.get('retry-after')
  if (!value || !/^\d{1,5}$/.test(value)) return null
  return Number(value)
}

export function createApiClient(options: {
  readonly origin: string
  readonly fetch: Fetch
  readonly userAgent: string
  readonly timeoutMs?: number
  /** Stops a request in flight when the command is cancelled. */
  readonly signal?: AbortSignal
}) {
  const timeoutMs = options.timeoutMs ?? 15_000

  async function call<T>(
    request: {
      readonly method: 'GET' | 'POST'
      readonly path: string
      readonly body?: unknown
      readonly secretKey?: string
      readonly success: number
    },
    parse: (value: unknown) => T | null,
  ): Promise<ApiResult<T>> {
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': options.userAgent }
    if (request.body !== undefined) headers['content-type'] = 'application/json'
    if (request.secretKey) headers['authorization'] = `Bearer ${request.secretKey}`
    const timeout = AbortSignal.timeout(timeoutMs)
    let response: Response
    try {
      response = await options.fetch(`${options.origin}${request.path}`, {
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
        redirect: 'error',
      })
    } catch (error) {
      return { ok: false, failure: { kind: 'network', reason: describeNetworkError(error) } }
    }
    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      body = null
    }
    if (response.status !== request.success) {
      const problem = record(body)
      const code = problem && typeof problem['code'] === 'string' ? problem['code'] : null
      return {
        ok: false,
        failure: { kind: 'problem', status: response.status, code, retryAfterSeconds: retryAfter(response) },
      }
    }
    const value = parse(body)
    return value === null ? { ok: false, failure: { kind: 'malformed', status: response.status } } : { ok: true, value }
  }

  return {
    /**
     * `keyset get`: one GET with the key, answered as it came. The path is already checked to be a `/v1/` path; the
     * origin cannot change because only the path is appended.
     */
    async get(
      secretKey: string,
      pathAndQuery: string,
    ): Promise<
      | { readonly ok: true; readonly status: number; readonly text: string }
      | { readonly ok: false; readonly reason: string }
    > {
      const timeout = AbortSignal.timeout(timeoutMs)
      try {
        const response = await options.fetch(`${options.origin}${pathAndQuery}`, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            'user-agent': options.userAgent,
            authorization: `Bearer ${secretKey}`,
          },
          signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
          redirect: 'error',
        })
        return { ok: true, status: response.status, text: await response.text() }
      } catch (error) {
        return { ok: false, reason: describeNetworkError(error) }
      }
    },
    startPairing(input: { readonly publicKey: string; readonly deviceName: string }) {
      return call({ method: 'POST', path: '/v1/cli/pairings', body: input, success: 201 }, parseStarted)
    },
    collectPairing(pairingSecret: string) {
      return call(
        { method: 'POST', path: '/v1/cli/pairings/token', body: { pairingSecret }, success: 200 },
        parseCollected,
      )
    },
    listEvents(
      secretKey: string,
      propertyId: string,
      page: { readonly after: string | null; readonly type: EventType | null },
    ) {
      const query = new URLSearchParams({ limit: '100' })
      if (page.after) query.set('after', page.after)
      if (page.type) query.set('type', page.type)
      return call(
        {
          method: 'GET',
          path: `/v1/properties/${encodeURIComponent(propertyId)}/events?${query.toString()}`,
          secretKey,
          success: 200,
        },
        parseEventPage,
      )
    },
    createTestEvent(secretKey: string, propertyId: string, type: EventType) {
      return call(
        {
          method: 'POST',
          path: `/v1/properties/${encodeURIComponent(propertyId)}/test-events`,
          body: { type },
          secretKey,
          success: 201,
        },
        parseTestEvent,
      )
    },
  }
}
export type ApiClient = ReturnType<typeof createApiClient>
