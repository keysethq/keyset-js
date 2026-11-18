import type { ApiClient } from './api.js'
import { isLiveKey, type StoredConfig } from './config.js'
import type { EventType } from './events.js'
import type { Terminal } from './io.js'

/**
 * `keyset trigger <type>` (ADR-051 §4): ask Keyset for one sample event. A live key never creates events (owner
 * decision of 15 Oct 2026); the CLI refuses before it sends anything, and the API refuses too.
 */
export async function trigger(deps: {
  readonly api: Pick<ApiClient, 'createTestEvent'>
  readonly config: StoredConfig
  readonly type: EventType
  readonly terminal: Terminal
}): Promise<number> {
  const { config, terminal } = deps
  if (isLiveKey(config.secretKey)) {
    terminal.err('A live key cannot create events. Run keyset login and choose the test business (Testbetrieb).')
    return 1
  }
  const result = await deps.api.createTestEvent(config.secretKey, config.propertyId, deps.type)
  if (result.ok) {
    terminal.out(`Created ${result.value.type} ${result.value.id}`)
    terminal.out('It is a sample: the booking or block it names may not exist.')
    terminal.out('keyset listen shows it within a few seconds; subscribed webhook endpoints receive it too.')
    return 0
  }
  const failure = result.failure
  if (failure.kind === 'network') {
    terminal.err(`Could not reach ${config.apiBaseUrl} (${failure.reason}). Nothing was created.`)
    return 1
  }
  if (failure.kind === 'malformed') {
    terminal.err('Keyset answered in a way this CLI does not understand. The event may have been created.')
    return 1
  }
  terminal.err(
    failure.status === 401
      ? 'Keyset no longer accepts this key. Run keyset login again.'
      : failure.code === 'LIVE_KEY'
        ? 'Keyset refused: a live key cannot create events. Run keyset login and choose the test business.'
        : failure.status === 403
          ? 'This key may not create events for its Property.'
          : failure.status === 404
            ? 'Keyset does not know this Property for this key. Run keyset login again.'
            : failure.status === 429
              ? 'Too many test events (at most twenty a minute per Property). Wait a minute and try again.'
              : failure.status === 422
                ? 'Keyset could not make this event. The Property needs at least one apartment.'
                : `Keyset could not create the event (status ${failure.status}).`,
  )
  return 1
}
