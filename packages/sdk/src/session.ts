// The guest's public session and checkout capabilities, as the SDK keeps them between calls. Shared by the server
// client (cookies it bridges itself) and the browser's direct mode (headers, 0.4.0); the relay mode keeps none.
/**
 * What the SDK has to remember between calls: the guest's public session and one capability per started checkout.
 *
 * A capability is bearer-equivalent — whoever holds it can read that checkout. Store it where you store the rest of
 * that guest's session, never in a cache shared between guests, and never in a log.
 */
export interface BookingSessionState {
  readonly session?: string
  /** Keyed by public checkout reference. */
  readonly capabilities: Readonly<Record<string, string>>
}

export interface BookingSessionStore {
  read(): BookingSessionState | Promise<BookingSessionState>
  write(state: BookingSessionState): void | Promise<void>
}

/**
 * A store held in this process only, for one guest session. It is an example/test helper: state is lost on process
 * restart and is not shared across instances. Use a durable application session store for a real multi-instance
 * service.
 *
 * Create one per guest. A single store reused for every guest would let a caller who knows another guest's checkout
 * reference read that checkout, because they would share its capability.
 */
export function createMemorySessionStore(initial?: BookingSessionState): BookingSessionStore {
  let state: BookingSessionState = initial ?? { capabilities: {} }
  return {
    read: () => state,
    write: (next) => {
      state = next
    },
  }
}

/**
 * 0.4.0, the browser's direct mode: this tab's session storage, one entry per booking page, so a reload keeps the
 * guest's session and the capability of a checkout in progress. Falls back to memory where storage is unavailable.
 * The capability is bearer-equivalent for that one checkout; it stays in this tab and is never put in a URL.
 */
export function createBrowserSessionStore(propertyId: string): BookingSessionStore {
  const name = `keyset.booking.${propertyId}`
  let memory: BookingSessionState = { capabilities: {} }
  return {
    read() {
      const raw = storage()?.getItem(name)
      if (!raw) return memory
      try {
        const parsed: unknown = JSON.parse(raw)
        return stateOf(parsed) ?? memory
      } catch {
        return memory
      }
    },
    write(state) {
      memory = state
      try {
        storage()?.setItem(name, JSON.stringify(state))
      } catch {
        // Storage full or refused: the memory copy still serves this page.
      }
    },
  }
}

const TOKEN = /^[A-Za-z0-9_-]{22,128}$/

/** This tab's session storage, where the platform has one and allows it. */
function storage(): Storage | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage
  } catch {
    return undefined
  }
}

function stateOf(value: unknown): BookingSessionState | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const session: unknown = Reflect.get(value, 'session')
  const capabilities: unknown = Reflect.get(value, 'capabilities')
  if (typeof capabilities !== 'object' || capabilities === null) return undefined
  const kept: Record<string, string> = {}
  for (const [reference, capability] of Object.entries(capabilities))
    if (/^[A-Za-z0-9_-]{22,64}$/.test(reference) && typeof capability === 'string' && TOKEN.test(capability))
      kept[reference] = capability
  return { ...(typeof session === 'string' && TOKEN.test(session) ? { session } : {}), capabilities: kept }
}
