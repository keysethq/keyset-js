/** The eight public event types (ADR-039); `trigger` and `listen --events` accept exactly these. */
export const EVENT_TYPES = [
  'reservation.confirmed',
  'reservation.changed',
  'reservation.cancelled',
  'payment.received',
  'refund.succeeded',
  'refund.failed',
  'block.created',
  'block.released',
] as const
export type EventType = (typeof EVENT_TYPES)[number]

export function eventType(value: unknown): EventType | null {
  for (const type of EVENT_TYPES) if (value === type) return type
  return null
}
