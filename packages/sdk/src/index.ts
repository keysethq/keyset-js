/**
 * `@keyset/sdk` — the official TypeScript SDK for the Keyset direct-booking API.
 *
 * This entrypoint is environment-neutral: types, the result model and the idempotency helper. Pick a client from the
 * entrypoint that matches where your code runs, because the two have different security properties:
 *
 * ```ts
 * import { createBookingClient } from '@keyset/sdk/browser' // same-origin, through your own relay
 * import { createBookingClient, createBookingRelay } from '@keyset/sdk/server' // your server, holds the capability
 * ```
 *
 * Five rules the API enforces and this SDK keeps explicit in its result model:
 *
 * 1. availability is advisory. Only a Checkout competes for inventory.
 * 2. a Quote is immutable and expires. Show its total; never a stale preview.
 * 3. an idempotency key belongs to one intent. Persist it before the first attempt and reuse it for every retry.
 * 4. a browser redirect confirms nothing. `checkoutStatus` is the only authority.
 * 5. an unknown outcome is not a failure. Repeat the identical request or read the state; never start a new intent.
 */
export type {
  Availability,
  AvailabilityCalendar,
  AvailabilityCalendarRequest,
  AvailabilityOffer,
  AvailabilityRequest,
  Bed,
  BedKind,
  BookingContact,
  BookingErrorCode,
  BookingExtra,
  BookingNotice,
  BookingProblem,
  BookingProperty,
  BookingState,
  BookingUnit,
  CalendarNight,
  Checkout,
  CheckoutAcceptance,
  CheckoutRequest,
  CheckoutState,
  CheckoutStatus,
  Host,
  ImageReference,
  Legal,
  LegalDocument,
  Money,
  Occupancy,
  PaymentSession,
  PaymentUi,
  PaymentState,
  PriceDiscountKind,
  PriceLine,
  PriceLineKind,
  PropertyPresentation,
  Quote,
  QuoteRequest,
  RatePlan,
  Refund,
  ReservationState,
  SafeNextAction,
  SleepingSpace,
  Stay,
  UnitPresentation,
} from './types.js'

export type { BookingFailure, BookingRecovery, BookingResult } from './result.js'
export { describeFailure, isOk, isUnknownOutcome, recoveryFor } from './result.js'
export type { BookingClient, MutationOptions, RequestOptions, WaitOptions } from './client.js'
export { isIdempotencyKey, parseCheckoutRequest } from './validate.js'

/**
 * A fresh idempotency key: 32 URL-safe characters from the platform CSPRNG.
 *
 * Persist the returned key with the intent it represents **before** dispatching, so a process restart can still
 * repeat the same request instead of creating a second booking.
 */
export function createIdempotencyKey(): string {
  const bytes = new Uint8Array(24)
  globalThis.crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}
