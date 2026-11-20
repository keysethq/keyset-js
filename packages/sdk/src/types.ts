/**
 * The public Keyset booking wire types.
 *
 * These are the SDK's own declarations on purpose. The package has no workspace or runtime dependency, so no Hono,
 * Zod, Drizzle, application or domain type can leak into a third-party build.
 *
 * They are kept honest mechanically rather than by review. `bun run check:api-contract` renders the published contract
 * from `@keyset/contracts`, asserts that this package's route table matches it, and feeds every example the document
 * publishes through the validators in `./validate.ts`. If a shape here stops matching the wire, that gate fails.
 *
 * Wire conventions that never change without a new major version:
 *
 * - money is an integer amount in minor units, carried as a decimal string, plus its currency. Never a float.
 * - a calendar day is `YYYY-MM-DD` in the property's own timezone.
 * - an instant is an RFC 3339 UTC timestamp without an offset suffix (`2027-02-01T12:00:00.000Z`).
 * - a stay is the half-open interval `[checkIn, checkOut)`, so the departure day is not a booked night.
 */

/** An integer amount in minor units (cents) with its currency. `"19500"` in `EUR` is EUR 195.00. */
export interface Money {
  /** A non-negative integer in minor units, as a decimal string. Parse with `BigInt`, never with `Number`. */
  readonly minorUnits: string
  readonly currency: string
}

/** How many guests occupy one unit. Infants are counted as children. */
export interface Occupancy {
  readonly adults: number
  readonly children: number
  /**
   * One age per child in years (0–17), optional. When given it holds exactly `children` entries; a host's surcharge
   * for further persons leaves children under the host's free age uncounted and prices older children by the host's
   * age bands, and a child whose age is not given pays as an adult.
   */
  readonly childAges?: readonly number[]
}

/** The half-open stay interval `[checkIn, checkOut)`. `nights` is always `checkOut - checkIn`. */
export interface Stay {
  /** Arrival day, `YYYY-MM-DD`. */
  readonly checkIn: string
  /** Departure day, `YYYY-MM-DD`. Not a booked night. */
  readonly checkOut: string
  readonly nights: number
}

/** One priced component of a total. The kinds are a closed set; a new kind is a major version. */
export type PriceLineKind =
  | 'nightly_accommodation'
  | 'weekend_adjustment'
  /** 0.3.0: a surcharge for a person above those the nightly price includes, one line per night. */
  | 'guest_surcharge'
  | 'cleaning_fee'
  | 'percentage_fee'
  /** 0.5.0: the host's discount on the accommodation, one line for the stay; its amount is negative. */
  | 'discount'
  /** 0.6.0: an extra the guest chose, named by the host. */
  | 'extra'
  /** 0.7.0: the tourist tax the host charges with the booking, one line for the stay; never discounted. */
  | 'tourist_tax'

export interface PriceLine {
  readonly kind: PriceLineKind
  /** The day this line is charged for, or `null` for a stay-level line such as a cleaning fee. */
  readonly serviceDate: string | null
  /**
   * Ready to show to the guest. Since 0.12 Keyset writes its own labels („Endreinigung“, „Kurtaxe“, a discount's name)
   * in the property's language: German for a `de` locale, English otherwise. A percentage fee, an extra and a rate
   * plan carry the host's own words. A label is fixed when the quote is made, so a quote made before 0.12 keeps its
   * English one; translate by `kind` and `discountKind` if your site speaks another language than the property.
   */
  readonly label: string
  readonly amount: Money
  /**
   * 0.12.0: which discount a `discount` line is; absent on every other line, and on a discount of a kind this version
   * does not know — show the label then.
   */
  readonly discountKind?: PriceDiscountKind
}

/** 0.12.0: a discount for a stay of some length, for booking early or late, or the rate plan the guest chose. */
export type PriceDiscountKind = 'length_of_stay' | 'early_booking' | 'last_minute' | 'rate_plan' | 'discount_code'

export type BedKind = 'double' | 'single' | 'sofa_bed' | 'bunk'

export interface Bed {
  readonly kind: BedKind
  readonly count: number
}

export interface SleepingSpace {
  readonly kind: 'bedroom' | 'living_room'
  readonly beds: readonly Bed[]
}

/** A published accommodation image. URLs are stable relative paths; resolve them against the API or your relay. */
export interface ImageReference {
  readonly assetKey: string
  readonly alt: string
  readonly role: 'cover' | 'gallery'
  readonly sortOrder: number
  readonly width: number
  readonly height: number
  readonly url: string
  readonly variants: Readonly<
    Record<
      'thumbnail' | 'small' | 'medium' | 'large',
      { readonly url: string; readonly width: number; readonly height: number }
    >
  >
}

export interface PropertyPresentation {
  /** An authored public locality label. Never a confidential street address. */
  readonly locality: string | null
  readonly description: string | null
  readonly images: readonly ImageReference[]
  /** 0.4.0: the host's words about the location; null when not written or from an API before them. */
  readonly location: string | null
  /** 0.4.0: amenity codes of Keyset's catalogue (`wifi`, `parking` …); new codes may appear — show the ones you know. */
  readonly amenities: readonly string[]
  /** 0.4.0: the host's frequently asked questions, in order. */
  readonly faq: readonly { readonly question: string; readonly answer: string }[]
}

export interface UnitPresentation {
  readonly description: string | null
  readonly sleepingArrangement: readonly SleepingSpace[]
  readonly images: readonly ImageReference[]
  /** 0.4.0: amenity codes of the apartment. */
  readonly amenities: readonly string[]
  /** 0.12.0: the floor area in whole square metres, as the host gave it; absent when not given. */
  readonly floorArea?: number
}

/** Who the guest books with, as the host published it. Each field may be null; show only what is there. */
export interface Host {
  readonly name: string | null
  readonly email: string | null
  readonly phone: string | null
}

/** One of the host's legal texts: a link to the host's own page, or the text itself. */
export type LegalDocument =
  | { readonly kind: 'link'; readonly url: string }
  | { readonly kind: 'text'; readonly text: string }

/**
 * 1.1.0: one step of tiered cancellation terms. Cancelled at least `hoursBeforeArrival` hours before the arrival time
 * on the arrival day, `refundBasisPoints` / 100 percent of the booking is refunded. Tiers are listed first tier first;
 * hours and shares fall from tier to tier.
 */
export interface RefundTier {
  readonly hoursBeforeArrival: number
  readonly refundBasisPoints: number
}

/** 1.1.0: a tier of terms bound to a stay; `until` is its deadline, property-local `YYYY-MM-DDTHH:MM`, inclusive. */
export interface BoundRefundTier extends RefundTier {
  readonly until: string
}

export interface Legal {
  readonly imprint: LegalDocument | null
  readonly privacy: LegalDocument | null
  /**
   * The active cancellation terms: cancelled at least `freeCancellationDays` before arrival, everything is
   * refunded; later, `lateRefundBasisPoints` / 100 percent. `testOnly` terms are never a host's real ones.
   */
  readonly cancellation: {
    readonly version: number
    readonly freeCancellationDays: number
    readonly lateRefundBasisPoints: number
    /**
     * 1.1.0: present for tiered terms only, and then the terms: the first tier whose deadline has not passed applies,
     * after the last one `lateRefundBasisPoints`. `freeCancellationDays` is then only a cautious summary (the fewest
     * whole days before arrival on which a cancellation at any hour still refunds everything; `0` when no tier does).
     */
    readonly refundTiers?: readonly RefundTier[]
    /** 1.1.0: with `refundTiers`, the property-local arrival time `HH:MM` the hours count back from. */
    readonly arrivalTime?: string
    readonly testOnly: boolean
  } | null
}

export interface BookingUnit {
  readonly publicUnitReference: string
  readonly displayName: string
  readonly maxOccupancy: number
  readonly presentation?: UnitPresentation
  /** The lowest nightly price over the bookable horizon, before stay fees — "from X per night". Null without one. */
  readonly leadPrice?: Money | null
  /** 0.6.0: extras the guest may add to a stay here, in the host's order. Absent when there are none. */
  readonly extras?: readonly BookingExtra[]
}

/** 0.6.0: an extra — `amount` once per stay, per night, or per person and night. */
export interface BookingExtra {
  readonly id: string
  readonly name: string
  readonly pricing: 'per_stay' | 'per_night' | 'per_person_night'
  readonly amount: Money
}

/** The bookable property and its units. The only endpoint that carries guest-facing content. */
export interface BookingProperty {
  readonly publicPropertyId: string
  /**
   * A short, stable alias of `publicPropertyId` for addresses people read and type — a page at `/p/<shortId>`.
   * `property()` is the one operation that also accepts it; send every other one the long id.
   */
  readonly shortId?: string
  readonly displayName: string
  /** BCP 47 language tag the labels are written in. */
  readonly locale: string
  /** IANA timezone the calendar days are expressed in. */
  readonly timezone: string
  readonly currency: string
  readonly presentation?: PropertyPresentation
  /** The host's contact. Show it on the booking page; the host, not Keyset, is the guest's contact for a stay. */
  readonly host?: Host
  /** The host's Impressum and privacy notice and the cancellation terms. Link them where the guest books. */
  readonly legal?: Legal
  /** Earliest local arrival time, `HH:MM` in `timezone`; `null` when the host has not set one. */
  readonly checkInTime?: string | null
  /** Latest local departure time, `HH:MM` in `timezone`; `null` when the host has not set one. */
  readonly checkOutTime?: string | null
  /**
   * 0.4.0: the kind of business — `holiday_apartments`, `guesthouse`, `holiday_home`, possibly more later. It names a
   * unit (apartment, room, house) and nothing else; treat an unknown value as `holiday_apartments`.
   */
  readonly businessProfile?: string
  /**
   * 0.4.0: `true` on the booking page of a business's test twin — payments are simulated, no guest is written to and
   * nothing booked there is real. Say so on every page. Absent for a real business.
   */
  readonly testMode?: true
  /**
   * 0.16.0: `false` while the host's payments are not set up — availability and prices read as usual, but
   * `startCheckout` answers `SERVICE_UNAVAILABLE`. Show the stay and the host's contact instead of asking for the
   * guest's details. Absent when the property takes bookings online.
   */
  readonly onlineBooking?: false
  /**
   * 1.2.0: whether the property takes new bookings now. `closed` while the host keeps it „not bookable yet“: the page,
   * its units, prices and availability read as usual, `onlineBooking` is `false`, and `createQuote` and `startCheckout`
   * answer `BOOKING_NOT_AVAILABLE` with the same status. With `opensOn` it takes bookings from that local date (in
   * `timezone`) by itself — say so („Buchbar ab März 2027“), hide the booking form or point to the host's contact.
   * Absent from servers that predate it; treat that as `open`.
   */
  readonly bookingStatus?: BookingStatus
  /** 0.5.0: `true` when the host keeps this page out of search engines; mark your page `noindex` then. */
  readonly noIndex?: true
  /**
   * 0.17.0: `true` when the host has a discount code on offer — show a field for one and pass it as `createQuote`'s
   * `discountCode`. Absent otherwise; it never says which code.
   */
  readonly discountCodes?: true
  /**
   * 0.8.0: the host's rates besides the standard rate, in the host's order — each a discount on the accommodation
   * with its own cancellation terms. Pass `ratePlan` to `createQuote` to book one. Absent when there are none.
   */
  readonly ratePlans?: readonly RatePlan[]
  readonly units: readonly BookingUnit[]
}

/**
 * 1.2.0: whether a property takes new bookings. `opensOn` is a local date, `YYYY-MM-DD` in the property's timezone,
 * from which a closed property takes bookings by itself; `null` while the host has named no date.
 */
export type BookingStatus = { readonly state: 'open' } | { readonly state: 'closed'; readonly opensOn: string | null }

/** 0.8.0: a rate besides the standard one. */
export interface RatePlan {
  readonly ratePlan: string
  readonly name: string
  /** Off the accommodation (nights, weekend and season prices, extra guests), in basis points. */
  readonly discountBasisPoints: number
  /** Free cancellation up to this many days before arrival; null when this rate never allows it. */
  readonly freeCancellationDays: number | null
  /** The share refunded outside the free period, in basis points. */
  readonly lateRefundBasisPoints: number
  /** The `publicUnitReference` of every unit this rate is not offered for. */
  readonly excludedUnits: readonly string[]
}

export interface AvailabilityRequest {
  readonly checkIn: string
  readonly checkOut: string
  readonly occupancy: Occupancy
}

export interface AvailabilityOffer {
  readonly publicUnitReference: string
  readonly displayName: string
  readonly maxOccupancy: number
  readonly stay: Stay
  readonly occupancy: Occupancy
  /** Advisory pricing. Only a Quote is authoritative. */
  readonly pricePreview: { readonly total: Money; readonly lineItems: readonly PriceLine[] }
}

/**
 * Advisory availability. `inventoryGuarantee` is always `none`: a search result is a read of a moving world and
 * never reserves anything. Only `startCheckout` competes for inventory.
 */
export interface Availability {
  readonly asOf: string
  readonly inventoryGuarantee: 'none'
  readonly offers: readonly AvailabilityOffer[]
}

/** A window of nights for a date picker. `nights` is 1 to 62; `from` is not before today. */
export interface AvailabilityCalendarRequest {
  /** The first night, `YYYY-MM-DD` in the property timezone. */
  readonly from: string
  readonly nights: number
  readonly occupancy: Occupancy
  /**
   * 0.12.0: one apartment instead of all of them, a `publicUnitReference` from `property()`. Every night then answers
   * for that apartment alone. An apartment the booking page does not offer is `not_found`, like an unknown property.
   */
  readonly publicUnitReference?: string
}

/**
 * One night of an availability calendar. A hint for a date picker, never a commitment: a free night does not mean
 * every stay through it is free, and only a Quote states what a stay costs.
 */
export interface CalendarNight {
  /** The night, `YYYY-MM-DD`. */
  readonly date: string
  /** At least one apartment that fits the party is free and priced this night. */
  readonly available: boolean
  /**
   * The lowest nightly price among those apartments, the night's own price including any weekend adjustment and
   * before stay-level fees (cleaning, service). `null` exactly when `available` is false.
   */
  readonly fromPrice: Money | null
  /** The shortest minimum stay among those apartments for an arrival this night. `null` when not available. */
  readonly minimumStayNights: number | null
  /** At least one of those apartments takes an arrival this night under the stay rules. `null` when not available. */
  readonly arrivalAllowed: boolean | null
  /** The longest maximum stay of an arrival this night; `null` when not available or when there is no maximum. */
  readonly maximumStayNights: number | null
  /** A stay may end on this day under the rules of its last night's period, whether or not this night is free. */
  readonly departureAllowed: boolean
}

/**
 * Nightly availability and prices for a date picker. `inventoryGuarantee` is always `none`, as for a search: it
 * reads a moving world and reserves nothing.
 */
export interface AvailabilityCalendar {
  readonly asOf: string
  readonly inventoryGuarantee: 'none'
  readonly occupancy: Occupancy
  /** One entry per night of the requested window, in date order. */
  readonly nights: readonly CalendarNight[]
}

export interface QuoteRequest {
  readonly publicUnitReference: string
  readonly checkIn: string
  readonly checkOut: string
  readonly occupancy: Occupancy
  /** 0.6.0: the ids of the unit's extras the guest chose; each becomes an `extra` price line. */
  readonly extras?: readonly string[]
  /** 0.8.0: one of the property's `ratePlans[].ratePlan`; absent for the standard rate. */
  readonly ratePlan?: string
  /**
   * 0.17.0: a discount code the host gave the guest, as typed (case and spaces do not matter); at most 40 characters.
   * A code that does not count is refused with `INVALID_BOOKING_DETAILS` and `discountCode: 'not_valid'`.
   */
  readonly discountCode?: string
}

/** An immutable, authoritative price for one stay. It expires; it is never repriced in place. */
export interface Quote {
  readonly publicQuoteReference: string
  readonly expiresAt: string
  readonly unit: { readonly publicUnitReference: string; readonly displayName: string }
  readonly stay: Stay
  readonly occupancy: Occupancy
  readonly total: Money
  readonly dueNow: Money
  readonly lineItems: readonly PriceLine[]
  readonly authoritative: true
  /**
   * The terms this quote binds: the last day, property-local, it can be cancelled free (null without terms, and for a
   * rate that never allows it); 0.8.0 adds the terms themselves when the API sends them.
   */
  readonly cancellation?: {
    readonly freeUntil: string | null
    readonly freeCancellationDays?: number | null
    readonly lateRefundBasisPoints?: number
    /** 1.1.0: the bound tiers of tiered terms, each with its deadline; absent for a day rule. See `Legal`. */
    readonly refundTiers?: readonly BoundRefundTier[]
    /** 1.1.0: with `refundTiers`, the property-local arrival time `HH:MM`. */
    readonly arrivalTime?: string
  }
  /** 0.8.0: the rate this quote was priced at; absent for the standard rate. */
  readonly ratePlan?: { readonly ratePlan: string; readonly name: string }
  /**
   * 0.17.0: the host's discount code this quote was priced with, as the host wrote it, and whether its discount is a
   * line of the quote (`false` when a higher discount of the host counts instead). Absent without a code.
   */
  readonly discountCode?: { readonly code: string; readonly applied: boolean }
  /**
   * 0.7.0: what the guest pays the host on arrival, outside `total` and `dueNow` — the tourist tax when the host
   * collects it on site. Absent when nothing is due on site.
   */
  readonly payableOnSite?: readonly { readonly kind: 'tourist_tax'; readonly amount: Money }[]
  /**
   * 0.10.0: present when the host takes a deposit — `dueNow` is then the deposit, and this is the rest, charged on
   * `dueOn` (property-local `YYYY-MM-DD`) from the card the deposit was paid with. Absent when all is due now.
   */
  readonly balance?: { readonly amount: Money; readonly dueOn: string }
  /**
   * 0.15.0: what this same stay costs at every rate offered for the unit — the standard rate first (`ratePlan` null),
   * then the host's order — for a rate choice that shows amounts. The chosen rate's entry is `total`; any other is the
   * `total` a quote with that rate would carry if made now, and nothing is held at it. Absent when only the standard
   * rate is offered.
   */
  readonly ratePlanTotals?: readonly { readonly ratePlan: string | null; readonly total: Money }[]
}

export interface BookingContact {
  readonly firstName: string
  readonly lastName: string
  readonly email: string
}

/** The guest's recorded acceptance. Send the exact versions you displayed. */
export interface CheckoutAcceptance {
  readonly termsVersion: string
  readonly cancellationPolicyVersion: string
  readonly privacyNoticeVersion: string
  readonly accepted: true
}

export interface CheckoutRequest {
  readonly publicQuoteReference: string
  readonly bookingContact: BookingContact
  /** 0.4.0: the language the guest booked in; the confirmation e-mail is written in it. German when absent. */
  readonly language?: 'de' | 'en'
  /**
   * 0.12.0: where the guest returns after paying, when your own website starts the checkout — an absolute `https`
   * address (loopback `http` for development) without credentials or fragment, at most 1000 characters. Its origin
   * must be listed on one of the business's active publishable keys in Keyset (Einstellungen › Entwickler › Eigene
   * Website), with the relay as well; otherwise the checkout is refused with `INVALID_BOOKING_DETAILS` and nothing is
   * held. Keyset adds `keyset_checkout=<publicCheckoutReference>`, so the page can read the checkout's status again.
   * Card payments complete in the page; only a payment that has to leave it comes back here. Absent: Keyset's own
   * booking page.
   */
  readonly returnUrl?: string
  /**
   * 0.14.0: how your page shows the payment form. `stripe_embedded_checkout` (the default) mounts Stripe's complete
   * embedded Checkout page. `stripe_checkout_elements` lets you build the form yourself from Stripe's Checkout Elements
   * (`stripe.initCheckoutElementsSdk`), in your site's own design; it needs `returnUrl`, because your page confirms the
   * payment and reads the outcome itself. Amount, currency, expiry and payment methods are the same either way, and
   * `checkoutStatus` stays the only confirmation.
   */
  readonly paymentUi?: PaymentUi
  readonly acceptance: CheckoutAcceptance
}

/** 0.14.0: the payment form a checkout is completed with. */
export type PaymentUi = 'stripe_embedded_checkout' | 'stripe_checkout_elements'

export type CheckoutState =
  | 'awaiting_payment'
  | 'requires_customer_action'
  | 'processing'
  | 'resolving'
  | 'completed'
  | 'expired'
  | 'failed'
  | 'needs_attention'

export type PaymentState = 'created' | 'requires_customer_action' | 'processing' | 'succeeded' | 'failed' | 'cancelled'

export type ReservationState = 'pending' | 'confirmed' | 'not_confirmed' | 'recovery_required'

/**
 * What a guest may safely be offered next. Payment, reservation and checkout are separate state dimensions; never
 * collapse them into one status, and never offer a second payment while an outcome is unresolved.
 */
export type SafeNextAction =
  | 'wait'
  | 'complete_payment'
  | 'start_new_search'
  | 'booking_confirmed'
  | 'contact_support'
  | 'none'

/** A started checkout. A reservation is not confirmed yet, whatever the browser does next. */
export interface Checkout {
  readonly publicCheckoutReference: string
  readonly expiresAt: string
  readonly checkoutState: 'awaiting_payment' | 'requires_customer_action'
  readonly paymentState: 'created' | 'requires_customer_action' | 'processing'
  readonly reservationState: 'pending'
  readonly safeNextAction: 'wait' | 'complete_payment'
}

/** The authoritative state of one checkout. This, never a browser redirect, decides whether a stay is booked. */
export interface CheckoutStatus {
  readonly publicCheckoutReference: string
  readonly expiresAt: string
  readonly property: { readonly publicPropertyId: string; readonly displayName: string }
  readonly unit: { readonly publicUnitReference: string; readonly displayName: string }
  readonly stay: Stay
  readonly occupancy: Occupancy
  readonly total: Money
  readonly lineItems: readonly PriceLine[]
  readonly checkoutState: CheckoutState
  readonly paymentState: PaymentState
  readonly reservationState: ReservationState
  /** Present once a reservation is confirmed. Twelve upper-case alphanumerics. */
  readonly confirmationReference?: string
  /**
   * The booking's number, counted per property from 1001 — the one the host sees and the one a guest quotes when
   * asking about the stay. Present exactly when `confirmationReference` is.
   */
  readonly reservationNumber?: number
  /** A non-secret hint about the payment surface. The client secret comes from `paymentSession` alone. */
  readonly paymentUi: { readonly kind: PaymentUi } | { readonly kind: 'none' }
  readonly safeNextAction: SafeNextAction
  /** Seconds to wait before polling again, present while the outcome is still moving. */
  readonly retryAfter?: number
  /** An opaque reference to quote when contacting the operator. Carries no personal data. */
  readonly supportReference?: string
  /**
   * True while the payment form is still being prepared: the guest has not been asked to pay, so nothing can have
   * been paid. Show a neutral loading state, never "payment processing". Absent from servers that predate it.
   */
  readonly paymentPreparing?: boolean
  /** When the hold keeping the apartment runs out, while nothing is confirmed; null otherwise. */
  readonly heldUntil?: string | null
  /** The confirmation e-mail's delivery once confirmed; null before and when none was sent. */
  readonly confirmationMail?: 'pending' | 'sent' | 'failed' | 'unknown' | null
  /**
   * 0.12.0: the guest's own page for the confirmed booking, for a link on the confirmation page. A bearer link: show
   * it to the guest who booked, never put it in a URL, log or analytics event of your own. Present for one day after
   * confirmation; `null` before, after that day (the guest's e-mails carry it) and once the host ended the booking's
   * links; absent from servers that predate it or serve no guest portal.
   */
  readonly guestPortalUrl?: string | null
  /**
   * When the host last changed the confirmed booking. Once set, `stay`, `unit` and `total` are the booking as changed
   * and `lineItems` is empty. `null` while it is as booked; absent from servers that predate it.
   */
  readonly changedAt?: string | null
  /**
   * 0.13.0: whether the booking this checkout produced still stands. `reservationState` stays `confirmed` once the
   * checkout made a booking, also after it was cancelled or the guest did not arrive; this says which. Never show a
   * booking as confirmed unless this is `confirmed` (or absent, from a server that predates it). `null` before the
   * checkout produced a booking. Once it is not `confirmed`, `safeNextAction` is `none`.
   */
  readonly bookingState?: BookingState | null
  /** 0.13.0: when the booking was cancelled; `null` unless `bookingState` is `cancelled`. */
  readonly cancelledAt?: string | null
  /** 0.13.0: who cancelled — `guest` (in the guest portal) or `host`; `null` unless `bookingState` is `cancelled`. */
  readonly cancelledBy?: 'guest' | 'host' | null
  /**
   * 0.13.0: money returned to the guest for this booking, across all its payments — after a cancellation, a price
   * the host lowered, a goodwill refund, or a paid checkout that could not become a booking. `null` when nothing was
   * refunded; absent from servers that predate it.
   */
  readonly refund?: Refund | null
  /** 0.9.0: the rate this booking was priced at; absent for the standard rate and from servers before rate plans. */
  readonly ratePlan?: { readonly ratePlan: string; readonly name: string }
  /**
   * 0.9.0: the cancellation terms this booking binds — the chosen rate's, else the host's in force when it was
   * quoted. `freeCancellationDays` and `freeUntil` are null when it can never be cancelled free of charge. Absent
   * when the host had published none, and from servers that predate it.
   */
  readonly cancellation?: {
    readonly freeUntil: string | null
    readonly freeCancellationDays: number | null
    readonly lateRefundBasisPoints: number
    /** 1.1.0: the bound tiers of tiered terms, each with its deadline; absent for a day rule. See `Legal`. */
    readonly refundTiers?: readonly BoundRefundTier[]
    /** 1.1.0: with `refundTiers`, the property-local arrival time `HH:MM`. */
    readonly arrivalTime?: string
  }
  /** 0.10.0: present when the host took a deposit — what was paid at booking; `total` stays the whole booking. */
  readonly deposit?: Money
  /**
   * 0.10.0: present when the host takes a deposit — `dueNow` is then the deposit, and this is the rest, charged on
   * `dueOn` (property-local `YYYY-MM-DD`) from the card the deposit was paid with. Absent when all is due now.
   */
  readonly balance?: { readonly amount: Money; readonly dueOn: string }
}

/** 0.13.0: whether a booking still stands; `no_show` means the guest did not arrive, which alone refunds nothing. */
export type BookingState = 'confirmed' | 'cancelled' | 'no_show'

/** 0.13.0: what is being or has been returned to the guest. */
export interface Refund {
  /** Everything being or already returned. */
  readonly amount: Money
  /** The part the payment provider has confirmed; it can take a few days to reach the card. */
  readonly refunded: Money
  /**
   * `pending` while a part is on its way or its outcome is not yet known, `succeeded` once all of `amount` is
   * refunded, `failed` when a part could not be refunded automatically: the host has been told, so tell the guest to
   * contact the host.
   */
  readonly state: 'pending' | 'succeeded' | 'failed'
}

/**
 * A short-lived payment handoff. Treat every field as a secret: never log it, never put it in a URL, never cache it.
 */
export interface PaymentSession {
  /** 0.14.0: `stripe_checkout_elements` only for a checkout started with that `paymentUi`. */
  readonly kind: PaymentUi
  readonly publishableKey: string
  readonly accountId: string
  readonly clientSecret: string
  readonly expiresAt: string
}

/**
 * Every error code the public booking API can return. A code the installed SDK does not know arrives as
 * `UNRECOGNIZED_PROBLEM`, with the server's own code in `serverCode`; branch on its `retryable` and `recovery`.
 */
export type BookingErrorCode =
  | 'AUTHENTICATION_REQUIRED'
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'INVALID_REQUEST'
  | 'INVENTORY_CONFLICT'
  | 'VERSION_CONFLICT'
  | 'PREVIEW_STALE'
  | 'POLICY_MISSING'
  | 'NOT_CANCELLABLE'
  | 'BOOKING_NOT_AVAILABLE'
  | 'INVALID_BOOKING_DETAILS'
  | 'TOO_MANY_REQUESTS'
  | 'QUOTE_EXPIRED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'APARTMENT_NO_LONGER_AVAILABLE'
  | 'CHECKOUT_EXPIRED'
  | 'PAYMENT_SESSION_UNAVAILABLE'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR'
  /** a write with this idempotency key is still running; repeat the identical request shortly. */
  | 'IDEMPOTENCY_IN_PROGRESS'
  /** an earlier write with this idempotency key has no known outcome; read the resource, never send a new key. */
  | 'IDEMPOTENCY_OUTCOME_UNKNOWN'
  /** a code newer than this SDK; `serverCode` carries it. */
  | 'UNRECOGNIZED_PROBLEM'

/** What a guest may read of a booking page that takes no booking: name, the host's contact and the legal texts. */
export interface BookingNotice {
  readonly state: 'paused' | 'empty'
  readonly publicPropertyId: string
  readonly shortId?: string
  readonly displayName: string
  readonly host: Host
  readonly legal: Legal
}

/** An RFC 9457 problem document with a stable Keyset `code`. */
export interface BookingProblem {
  readonly type: 'about:blank'
  readonly title: string
  readonly status: number
  readonly code: BookingErrorCode
  /** With `UNRECOGNIZED_PROBLEM` only: the code as the server sent it. */
  readonly serverCode?: string
  /** Whether repeating the identical request can still succeed. */
  readonly retryable: boolean
  /** Seconds to wait before repeating, when the API asked for a specific delay. */
  readonly retryAfter?: number
  /**
   * Read tolerantly, from servers that have it: with `BOOKING_NOT_AVAILABLE` on the property read, when the page exists but takes no booking: `paused` by
   * the host, or `empty` (published, no apartment switched on), with the name, the host's contact and the legal texts.
   * Absent when no booking page answers to the identifier, and from servers that predate it.
   */
  readonly unavailable?: BookingNotice
  /**
   * With `INVALID_BOOKING_DETAILS` when the dates break the apartment's stay rules: which rule, and the figures that
   * explain it (`allowedDays` are ISO weekdays, 1 = Monday). Absent from servers that predate it.
   */
  readonly stayRule?: {
    readonly reason:
      | 'minimum_stay_not_satisfied'
      | 'maximum_stay_exceeded'
      | 'arrival_day_not_allowed'
      | 'departure_day_not_allowed'
    readonly requiredNights?: number
    readonly maximumNights?: number
    readonly allowedDays?: readonly number[]
  }
  /**
   * 0.17.0: with `INVALID_BOOKING_DETAILS` on `createQuote` when the `discountCode` does not count — the same answer
   * whether it never existed, was ended, is not valid today or is malformed. Absent from servers that predate it.
   */
  readonly discountCode?: 'not_valid'
  /**
   * 1.2.0: with `BOOKING_NOT_AVAILABLE` (status 409) on `createQuote` and `startCheckout` when the host has closed the
   * property to new bookings — always `state: 'closed'`, with the date it opens if the host named one. Repeating the
   * call does not help before then. Absent from servers that predate it.
   */
  readonly bookingStatus?: BookingStatus
}
