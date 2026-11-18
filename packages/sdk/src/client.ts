import type { BookingResult } from './result.js'
import { ROUTES, send, guard, type Wire } from './transport.js'
import type {
  Availability,
  AvailabilityCalendar,
  AvailabilityCalendarRequest,
  AvailabilityRequest,
  BookingProperty,
  Checkout,
  CheckoutRequest,
  CheckoutStatus,
  PaymentSession,
  Quote,
  QuoteRequest,
} from './types.js'
import {
  assertAvailabilityCalendarRequest,
  assertAvailabilityRequest,
  assertCheckoutRequest,
  assertIdempotencyKey,
  assertQuoteRequest,
  assertReference,
  parseAvailability,
  parseAvailabilityCalendar,
  parseBookingProperty,
  parseCheckout,
  parseCheckoutStatus,
  parsePaymentSession,
  parseQuote,
} from './validate.js'

export interface RequestOptions {
  /** Cancels the request. A cancelled mutation is an unknown outcome, not a failure. */
  readonly signal?: AbortSignal
}

export interface MutationOptions extends RequestOptions {
  /**
   * The key that identifies this one intent. Generate it with `createIdempotencyKey()`, persist it **before** the
   * first attempt, and reuse the identical key for every retry of the same intent. A fresh key is a new intent and
   * can produce a second booking.
   */
  readonly idempotencyKey: string
}

export interface WaitOptions extends RequestOptions {
  /** Overall budget in milliseconds. Default 120000. */
  readonly timeoutMs?: number
  /** Called before each poll with the seconds the API asked to wait. Useful for progress reporting. */
  readonly onWait?: (seconds: number) => void
}

/**
 * The supported external booking surface.
 *
 * The order is the flow: read the property, look at the nightly calendar and availability, take an authoritative
 * Quote, start a Checkout, then read the authoritative Checkout status until it stops asking you to wait.
 */
export interface BookingClient {
  /** The property this client is bound to. */
  readonly propertyId: string
  /**
   * The bookable property, its units and their guest-facing content. 0.4.0: `language: 'en'` answers the host's own
   * texts in English where the host wrote them, in German where not.
   */
  property(options?: RequestOptions & { readonly language?: 'de' | 'en' }): Promise<BookingResult<BookingProperty>>
  /**
   * Per night of a window of up to 62: whether an apartment that fits the party is free, its lowest nightly price
   * and the shortest minimum stay — for a date picker. A hint, never a commitment; only a Checkout competes for
   * inventory. Shares the search budget.
   */
  availabilityCalendar(
    request: AvailabilityCalendarRequest,
    options?: RequestOptions,
  ): Promise<BookingResult<AvailabilityCalendar>>
  /** Advisory availability and preview pricing. Never a commitment; only a Checkout competes for inventory. */
  searchAvailability(request: AvailabilityRequest, options?: RequestOptions): Promise<BookingResult<Availability>>
  /** An immutable, authoritative price. Show this total, not a preview, before asking a guest to book. */
  createQuote(request: QuoteRequest, options: MutationOptions): Promise<BookingResult<Quote>>
  /** Starts the booking. Success means the attempt is durable, not that a reservation is confirmed. */
  startCheckout(request: CheckoutRequest, options: MutationOptions): Promise<BookingResult<Checkout>>
  /** The authoritative outcome. This decides whether a stay is booked; a browser redirect never does. */
  checkoutStatus(reference: string, options?: RequestOptions): Promise<BookingResult<CheckoutStatus>>
  /** A short-lived payment handoff. Every field is a secret; request it only when you are about to use it. */
  paymentSession(reference: string, options?: RequestOptions): Promise<BookingResult<PaymentSession>>
  /**
   * Polls `checkoutStatus` while the API keeps answering `safeNextAction: 'wait'`, honouring its `retryAfter`.
   * Reads only; it never mutates and never starts a second payment. If the budget elapses first it resolves with the
   * latest status, so check `safeNextAction` rather than assuming the flow finished.
   */
  waitForCheckout(reference: string, options?: WaitOptions): Promise<BookingResult<CheckoutStatus>>
}

function sleep(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop)
      resolve()
    }, milliseconds)
    function stop() {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', stop, { once: true })
  })
}

/** Builds the client over a prepared wire. Both entrypoints use this; only the wire differs. */
export function createClient(wire: Wire, propertyId: string, now: () => number = Date.now): BookingClient {
  const property = { publicPropertyId: propertyId }
  return {
    propertyId,
    property: (options) =>
      send(wire, {
        route: ROUTES.getBookingProperty,
        parameters: property,
        ...(options?.language === 'en' ? { query: { lang: 'en' } } : {}),
        parse: parseBookingProperty,
        ...(options?.signal ? { signal: options.signal } : {}),
      }),
    availabilityCalendar: async (request, options) =>
      guard(() => {
        assertAvailabilityCalendarRequest(request)
      }) ??
      (await send(wire, {
        route: ROUTES.readAvailabilityCalendar,
        parameters: property,
        query: {
          from: request.from,
          nights: String(request.nights),
          adults: String(request.occupancy.adults),
          children: String(request.occupancy.children),
          ...(request.publicUnitReference !== undefined ? { publicUnitReference: request.publicUnitReference } : {}),
        },
        parse: parseAvailabilityCalendar,
        ...(options?.signal ? { signal: options.signal } : {}),
      })),
    searchAvailability: async (request, options) =>
      guard(() => {
        assertAvailabilityRequest(request)
      }) ??
      (await send(wire, {
        route: ROUTES.searchAvailability,
        parameters: property,
        parse: parseAvailability,
        body: { checkIn: request.checkIn, checkOut: request.checkOut, occupancy: request.occupancy },
        ...(options?.signal ? { signal: options.signal } : {}),
      })),
    createQuote: async (request, options) =>
      guard(() => {
        assertIdempotencyKey(options.idempotencyKey)
        assertQuoteRequest(request)
      }) ??
      (await send(wire, {
        route: ROUTES.createQuote,
        parameters: property,
        parse: parseQuote,
        body: {
          publicUnitReference: request.publicUnitReference,
          checkIn: request.checkIn,
          checkOut: request.checkOut,
          occupancy: request.occupancy,
          ...(request.extras && request.extras.length > 0 ? { extras: request.extras } : {}),
          ...(request.ratePlan ? { ratePlan: request.ratePlan } : {}),
          ...(request.discountCode ? { discountCode: request.discountCode } : {}),
        },
        idempotencyKey: options.idempotencyKey,
        ...(options.signal ? { signal: options.signal } : {}),
      })),
    startCheckout: async (request, options) =>
      guard(() => {
        assertIdempotencyKey(options.idempotencyKey)
        assertCheckoutRequest(request)
      }) ??
      (await send(wire, {
        route: ROUTES.startCheckout,
        parameters: property,
        parse: parseCheckout,
        body: {
          publicQuoteReference: request.publicQuoteReference,
          bookingContact: request.bookingContact,
          ...(request.language ? { language: request.language } : {}),
          ...(request.returnUrl !== undefined ? { returnUrl: request.returnUrl } : {}),
          ...(request.paymentUi !== undefined ? { paymentUi: request.paymentUi } : {}),
          acceptance: request.acceptance,
        },
        idempotencyKey: options.idempotencyKey,
        ...(options.signal ? { signal: options.signal } : {}),
      })),
    checkoutStatus: async (reference, options) =>
      guard(() => {
        assertReference(reference, 'publicCheckoutReference')
      }) ??
      (await send(wire, {
        route: ROUTES.readCheckoutStatus,
        parameters: { publicCheckoutReference: reference },
        // A website's confirmation page links the guest portal; Keyset mints that link only when asked.
        query: { include: 'guestPortalUrl' },
        parse: parseCheckoutStatus,
        checkoutReference: reference,
        ...(options?.signal ? { signal: options.signal } : {}),
      })),
    paymentSession: async (reference, options) =>
      guard(() => {
        assertReference(reference, 'publicCheckoutReference')
      }) ??
      (await send(wire, {
        route: ROUTES.readPaymentSession,
        parameters: { publicCheckoutReference: reference },
        parse: parsePaymentSession,
        checkoutReference: reference,
        ...(options?.signal ? { signal: options.signal } : {}),
      })),
    async waitForCheckout(reference, options) {
      const deadline = now() + (options?.timeoutMs ?? 120_000)
      let latest = await this.checkoutStatus(reference, options?.signal ? { signal: options.signal } : {})
      while (latest.ok && latest.value.safeNextAction === 'wait' && now() < deadline) {
        const seconds = latest.value.retryAfter ?? 2
        options?.onWait?.(seconds)
        await sleep(seconds * 1000, options?.signal)
        if (options?.signal?.aborted) return latest
        latest = await this.checkoutStatus(reference, options?.signal ? { signal: options.signal } : {})
      }
      return latest
    },
  }
}
