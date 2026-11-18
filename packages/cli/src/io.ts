import { setTimeout as delay } from 'node:timers/promises'

/** Where a command writes: `out` for results, `err` for problems. Tests collect the lines. */
export interface Terminal {
  out(line: string): void
  err(line: string): void
}

/** Waits, or returns early once `signal` aborts; it never rejects. */
export type Sleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>

export const sleep: Sleep = async (milliseconds, signal) => {
  try {
    await delay(milliseconds, undefined, signal ? { signal } : {})
  } catch {
    // Aborted: the caller looks at the signal.
  }
}
