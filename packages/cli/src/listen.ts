import type { ApiClient, ApiFailure, KeysetEvent } from './api.js'
import { isLiveKey, shownWebhookSecret, type StoredConfig } from './config.js'
import type { EventType } from './events.js'
import { envelope, type ForwardTarget, forwardEvent } from './forward.js'
import type { Sleep, Terminal } from './io.js'
import { PRODUCTION_API } from './urls.js'

export interface ListenDependencies {
  readonly api: Pick<ApiClient, 'listEvents'>
  readonly config: StoredConfig
  /** Where to post each event, signed; null only prints (`--print-json`). Its fetch is injected so tests need no listener. */
  readonly forward: Omit<ForwardTarget, 'webhookSecret'> | null
  /** `--print-json`: each event's body as one line on stdout, everything else on stderr. */
  readonly printJson: boolean
  /** Null forwards every type. */
  readonly types: readonly EventType[] | null
  readonly terminal: Terminal
  readonly sleep: Sleep
  readonly now: () => Date
  readonly signal: AbortSignal
  readonly pollMs?: number
}

const POLL_MS = 2000
const BACKOFF_START_MS = 5000
const BACKOFF_CEILING_MS = 60_000

function clock(date: Date): string {
  return date.toTimeString().slice(0, 8)
}

type Fatal = { readonly fatal: string }

function fatal(failure: ApiFailure): Fatal | null {
  if (failure.kind !== 'problem') return null
  if (failure.status === 401) return { fatal: 'Keyset no longer accepts this key. Run keyset login again.' }
  if (failure.status === 403)
    return { fatal: 'This key may not read the events of its Property. Run keyset login again.' }
  if (failure.status === 404)
    return { fatal: 'Keyset does not know this Property for this key. Run keyset login again.' }
  return null
}

/**
 * `keyset listen` (ADR-051 §3): find the newest event, then poll every two seconds and post each new event to the
 * local address exactly as the worker would, signed with the local secret. A local failure is reported and never
 * retried; the loop goes on. Returns the exit code.
 */
export async function listen(deps: ListenDependencies): Promise<number> {
  const { config, signal } = deps
  // With --print-json, stdout carries only the events, so a pipe into jq sees nothing else.
  const terminal: Terminal = deps.printJson
    ? { out: (line) => deps.terminal.err(line), err: (line) => deps.terminal.err(line) }
    : deps.terminal
  const livemode = isLiveKey(config.secretKey) && config.apiBaseUrl === PRODUCTION_API
  // The API filters by one type; for several, ask for all and filter here. The cursor moves over every event seen.
  const serverType = deps.types?.length === 1 ? (deps.types[0] ?? null) : null
  const wanted = deps.types ? new Set<string>(deps.types) : null
  let backoff = BACKOFF_START_MS
  let troubled = false

  /** One page, or a wait after a recoverable failure (null), or the end. */
  async function page(after: string | null, type: EventType | null) {
    const result = await deps.api.listEvents(config.secretKey, config.propertyId, { after, type })
    if (result.ok) {
      if (troubled) terminal.err('Connected again.')
      troubled = false
      backoff = BACKOFF_START_MS
      return result.value
    }
    const stop = fatal(result.failure)
    if (stop) return stop
    const failure = result.failure
    if (failure.kind === 'problem' && failure.status === 422 && after !== null) return 'lost_cursor' as const
    const wait =
      failure.kind === 'problem' && failure.status === 429 && failure.retryAfterSeconds !== null
        ? Math.min(failure.retryAfterSeconds * 1000, BACKOFF_CEILING_MS)
        : backoff
    if (!troubled) {
      const reason =
        failure.kind === 'network'
          ? failure.reason
          : failure.kind === 'problem' && failure.status === 429
            ? 'too many requests'
            : `status ${failure.status}`
      terminal.err(`Could not read events from Keyset (${reason}). Trying again.`)
      troubled = true
    }
    backoff = Math.min(backoff * 2, BACKOFF_CEILING_MS)
    await deps.sleep(wait, signal)
    return null
  }

  /** The id of the newest event, so `listen` forwards only what happens from now on. */
  async function newest(): Promise<string | null | Fatal> {
    let cursor: string | null = null
    while (!signal.aborted) {
      const result = await page(cursor, null)
      if (result === null) continue
      if (result === 'lost_cursor') {
        cursor = null
        continue
      }
      if ('fatal' in result) return result
      const last = result.events.at(-1)
      if (last) cursor = last.id
      if (!result.hasMore) return cursor
    }
    return cursor
  }

  async function forward(event: KeysetEvent) {
    if (deps.printJson) deps.terminal.out(envelope(event, livemode))
    if (!deps.forward) return
    const outcome = await forwardEvent({ ...deps.forward, webhookSecret: config.webhookSecret }, event, {
      livemode,
      now: deps.now(),
      signal,
    })
    if (outcome !== null) terminal.out(`${clock(deps.now())}  ${event.type.padEnd(21)}  ${event.id}  ${outcome}`)
  }

  terminal.out(`Checking for events of ${config.propertyName} on ${config.apiBaseUrl}...`)
  const start = await newest()
  if (start !== null && typeof start === 'object') {
    terminal.err(start.fatal)
    return 1
  }
  if (signal.aborted) return 0
  let cursor = start
  terminal.out(deps.forward ? `Ready. Forwarding new events to ${deps.forward.url}` : 'Ready. Printing new events.')
  if (deps.types) terminal.out(`Only: ${deps.types.join(', ')}`)
  if (deps.forward) {
    terminal.out(`Webhook signing secret: ${shownWebhookSecret(config)}`)
    terminal.out('Verify signatures with it in your receiver. Press Ctrl-C to stop.')
  } else terminal.out('Press Ctrl-C to stop.')
  if (livemode) terminal.out('This is a live key: forwarded events carry livemode: true.')

  while (!signal.aborted) {
    await deps.sleep(deps.pollMs ?? POLL_MS, signal)
    let more = true
    while (more && !signal.aborted) {
      const result = await page(cursor, serverType)
      if (result === null) break
      if (result === 'lost_cursor') {
        terminal.err('Keyset no longer knows the last event seen; continuing from the newest one.')
        const restart = await newest()
        if (restart !== null && typeof restart === 'object') {
          terminal.err(restart.fatal)
          return 1
        }
        cursor = restart
        break
      }
      if ('fatal' in result) {
        terminal.err(result.fatal)
        return 1
      }
      for (const event of result.events) {
        if (signal.aborted) break
        if (!wanted || wanted.has(event.type)) await forward(event)
        cursor = event.id
      }
      more = result.hasMore
    }
  }
  return 0
}
