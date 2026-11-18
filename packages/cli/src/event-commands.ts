import type { ApiClient, ApiFailure, KeysetEvent } from './api.js'
import { isLiveKey, shownWebhookSecret, type StoredConfig } from './config.js'
import type { EventType } from './events.js'
import { type ForwardTarget, forwardEvent } from './forward.js'
import type { Terminal } from './io.js'
import { PRODUCTION_API } from './urls.js'

function explain(failure: ApiFailure, apiBaseUrl: string): string {
  if (failure.kind === 'network') return `Could not reach ${apiBaseUrl} (${failure.reason}).`
  if (failure.kind === 'malformed') return 'Keyset answered in a way this CLI does not understand.'
  if (failure.status === 401) return 'Keyset no longer accepts this key. Run keyset login again.'
  if (failure.status === 403) return 'This key may not read the events of its Property.'
  if (failure.status === 404) return 'Keyset does not know this Property for this key. Run keyset login again.'
  return `Keyset could not list the events (status ${failure.status}).`
}

/**
 * Walks the events list (oldest first, thirty days) until `stop` says so. The list has no route for one event, so
 * `resend` looks for it the same way; a small business has a few hundred events a month.
 */
async function walk(
  api: Pick<ApiClient, 'listEvents'>,
  config: StoredConfig,
  type: EventType | null,
  visit: (event: KeysetEvent) => boolean,
): Promise<ApiFailure | null> {
  let after: string | null = null
  for (;;) {
    const result = await api.listEvents(config.secretKey, config.propertyId, { after, type })
    if (!result.ok) return result.failure
    for (const event of result.value.events) if (visit(event)) return null
    const last = result.value.events.at(-1)
    if (!result.value.hasMore || !last) return null
    after = last.id
  }
}

/** `keyset events list`: the newest events first, `limit` of them. */
export async function listEventsCommand(deps: {
  readonly api: Pick<ApiClient, 'listEvents'>
  readonly config: StoredConfig
  readonly type: EventType | null
  readonly limit: number
  readonly terminal: Terminal
}): Promise<number> {
  const kept: KeysetEvent[] = []
  const failure = await walk(deps.api, deps.config, deps.type, (event) => {
    kept.push(event)
    if (kept.length > deps.limit) kept.shift()
    return false
  })
  if (failure) {
    deps.terminal.err(explain(failure, deps.config.apiBaseUrl))
    return 1
  }
  if (kept.length === 0) {
    deps.terminal.out('No events in the last thirty days.')
    return 0
  }
  for (const event of kept.toReversed())
    deps.terminal.out(`${event.createdAt.slice(0, 19).replace('T', ' ')}  ${event.type.padEnd(21)}  ${event.id}`)
  return 0
}

/**
 * `keyset events resend <id> --forward-to <url>` (Stripe's `events resend`): post one past event to the local address
 * again, signed with the CLI's secret, as `listen` would have. Keyset's own endpoints resend from the operator app.
 */
export async function resendEventCommand(deps: {
  readonly api: Pick<ApiClient, 'listEvents'>
  readonly config: StoredConfig
  readonly id: string
  readonly forward: Omit<ForwardTarget, 'webhookSecret'>
  readonly terminal: Terminal
  readonly now: () => Date
  readonly signal: AbortSignal
}): Promise<number> {
  const { config, terminal } = deps
  const hit: { event: KeysetEvent | null } = { event: null }
  const failure = await walk(deps.api, config, null, (event) => {
    if (event.id !== deps.id) return false
    hit.event = event
    return true
  })
  if (failure) {
    terminal.err(explain(failure, config.apiBaseUrl))
    return 1
  }
  const event = hit.event
  if (!event) {
    terminal.err(`${deps.id} is not among this Property's events of the last thirty days.`)
    return 1
  }
  const livemode = isLiveKey(config.secretKey) && config.apiBaseUrl === PRODUCTION_API
  const outcome = await forwardEvent({ ...deps.forward, webhookSecret: config.webhookSecret }, event, {
    livemode,
    now: deps.now(),
    signal: deps.signal,
  })
  if (outcome === null) return 1
  terminal.out(`${event.type}  ${event.id}  ${outcome}`)
  terminal.out(`Signed with ${shownWebhookSecret(config)}`)
  return /^\[2\d\d\]$/.test(outcome) ? 0 : 1
}
