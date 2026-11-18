/**
 * Dependency-free validation for the public Keyset booking wire format.
 *
 * Two rules govern every check here, and they are not symmetric.
 *
 * Requests are validated permissively-or-equally against the API. The check exists to save a round trip on an obvious
 * mistake, never to become a second, stricter contract: anything the API accepts must reach it. The API stays the
 * authority and answers `INVALID_BOOKING_DETAILS` for the rest.
 *
 * Responses are validated on their required fields and their closed enumerations, and unknown object keys are
 * ignored. Ignoring unknown keys is a deliberate difference from Keyset's internal client, which rejects them: an
 * installed SDK must survive an additive API change. Enumerations stay closed on purpose, because `checkoutState`,
 * `paymentState`, `reservationState` and `safeNextAction` are the booking safety machine — a client that does not
 * understand a state must not act on it. Adding a member to one of them is therefore a breaking change for SDK
 * consumers, and `scripts/check-openapi-contract.mjs` refuses it without an explicit decision.
 */
import type {
  Availability,
  AvailabilityCalendar,
  AvailabilityCalendarRequest,
  AvailabilityOffer,
  AvailabilityRequest,
  BookingErrorCode,
  BookingProblem,
  BookingProperty,
  BookingUnit,
  Checkout,
  CheckoutRequest,
  CheckoutStatus,
  Host,
  Legal,
  LegalDocument,
  Money,
  Occupancy,
  PaymentSession,
  PriceDiscountKind,
  PriceLine,
  PropertyPresentation,
  Quote,
  QuoteRequest,
  Refund,
  Stay,
  UnitPresentation,
} from './types.js'

export class ShapeError extends Error {
  readonly path: string
  constructor(path: string, expectation: string) {
    super(`${path || 'value'} ${expectation}`)
    this.name = 'ShapeError'
    this.path = path
  }
}

const PUBLIC_REFERENCE = /^[A-Za-z0-9_-]{22,64}$/
/** 0.12.0: a guest portal link — an http(s) origin, then `/g/` and the 43-character token. */
const PORTAL_URL = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\/g\/[A-Za-z0-9_-]{43}$/

/** 0.8.0: a rate plan's reference. */
const RATE_PLAN = /^[A-Za-z0-9_-]{22}$/
const MINOR_UNITS = /^(0|[1-9]\d*)$/
/** 0.5.0: a price line may be negative — a discount; every total stays non-negative. */
const SIGNED_MINOR_UNITS = /^(0|-?[1-9]\d*)$/
const CALENDAR_DAY = /^(\d{4})-(\d{2})-(\d{2})$/
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?Z$/
const CONFIRMATION_REFERENCE = /^[A-Z0-9]{12}$/
const SHORT_ID = /^[0-9a-hjkmnp-tv-z]{8}$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/
const LOCAL_TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/

function fail(path: string, expectation: string): never {
  throw new ShapeError(path, expectation)
}

function record(value: unknown, path: string): object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'must be an object')
  return value
}

/** Reads one own property as `unknown`. Unknown keys are ignored on purpose: an installed SDK must survive an
 * additive API change. */
function at(source: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(source, key)?.value
}

function text(value: unknown, path: string, min: number, max: number): string {
  if (typeof value !== 'string') fail(path, 'must be a string')
  if (value.length < min || value.length > max) fail(path, `must be ${min}..${max} characters`)
  return value
}

function integer(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) fail(path, 'must be an integer')
  if (value < min || value > max) fail(path, `must be ${min}..${max}`)
  return value
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'must be a boolean')
  return value
}

function literalTrue(value: unknown, path: string): true {
  if (value !== true) fail(path, 'must be true when present')
  return true
}

function literalFalse(value: unknown, path: string): false {
  if (value !== false) fail(path, 'must be false when present')
  return false
}

function member<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  // Returns the member from `allowed`, so no assertion is needed to reach the literal type.
  for (const candidate of allowed) if (value === candidate) return candidate
  return fail(path, `must be one of ${allowed.join(', ')}`)
}

function list(value: unknown, path: string, max: number): readonly unknown[] {
  if (!Array.isArray(value)) fail(path, 'must be an array')
  if (value.length > max) fail(path, `must hold at most ${max} entries`)
  return value
}

function exactly(value: readonly unknown[], length: number, path: string): readonly unknown[] {
  if (value.length !== length) fail(path, `must hold exactly ${length} entries`)
  return value
}

function matches(value: unknown, path: string, pattern: RegExp, expectation: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) fail(path, expectation)
  return value
}

/** A real calendar day in `YYYY-MM-DD`. Rejects `2027-02-30` as well as a malformed string. */
function calendarDay(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, 'must be a calendar day in YYYY-MM-DD form')
  const parts = CALENDAR_DAY.exec(value)
  if (!parts) fail(path, 'must be a calendar day in YYYY-MM-DD form')
  const year = Number(parts[1])
  const month = Number(parts[2])
  const day = Number(parts[3])
  const stamp = Date.UTC(year, month - 1, day)
  const round = new Date(stamp)
  if (round.getUTCFullYear() !== year || round.getUTCMonth() + 1 !== month || round.getUTCDate() !== day)
    fail(path, 'must be a real calendar day')
  return value
}

/** An RFC 3339 UTC instant without an offset suffix. */
function instant(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, 'must be a UTC instant such as 2027-02-01T12:00:00.000Z')
  if (!INSTANT.test(value)) fail(path, 'must be a UTC instant such as 2027-02-01T12:00:00.000Z')
  if (Number.isNaN(Date.parse(value))) fail(path, 'must be a real instant')
  return value
}

function money(value: unknown, path: string, signed = false): Money {
  const source = record(value, path)
  return {
    minorUnits: matches(
      at(source, 'minorUnits'),
      `${path}.minorUnits`,
      signed ? SIGNED_MINOR_UNITS : MINOR_UNITS,
      'must be integer minor units',
    ),
    currency: matches(at(source, 'currency'), `${path}.currency`, /^[A-Z]{3}$/, 'must be an ISO currency code'),
  }
}

function occupancy(value: unknown, path: string): Occupancy {
  const source = record(value, path)
  const children = integer(at(source, 'children'), `${path}.children`, 0, 20)
  const ages = at(source, 'childAges')
  return {
    adults: integer(at(source, 'adults'), `${path}.adults`, 1, 20),
    children,
    ...(ages === undefined
      ? {}
      : {
          childAges: exactly(list(ages, `${path}.childAges`, children), children, `${path}.childAges`).map(
            (age, index) => integer(age, `${path}.childAges[${index}]`, 0, 17),
          ),
        }),
  }
}

function stay(value: unknown, path: string): Stay {
  const source = record(value, path)
  return {
    checkIn: calendarDay(at(source, 'checkIn'), `${path}.checkIn`),
    checkOut: calendarDay(at(source, 'checkOut'), `${path}.checkOut`),
    nights: integer(at(source, 'nights'), `${path}.nights`, 1, 90),
  }
}

function priceLine(value: unknown, path: string): PriceLine {
  const source = record(value, path)
  const serviceDate = at(source, 'serviceDate')
  // 0.12: a discount kind this version does not know is left out rather than refused; the label still names it.
  const discountKind = DISCOUNT_KINDS.find((candidate) => candidate === at(source, 'discountKind'))
  return {
    kind: member(at(source, 'kind'), `${path}.kind`, [
      'nightly_accommodation',
      'weekend_adjustment',
      'guest_surcharge',
      'cleaning_fee',
      'percentage_fee',
      'discount',
      'extra',
      'tourist_tax',
    ] as const),
    serviceDate: serviceDate === null ? null : calendarDay(serviceDate, `${path}.serviceDate`),
    label: text(at(source, 'label'), `${path}.label`, 1, 120),
    amount: money(at(source, 'amount'), `${path}.amount`, true),
    ...(discountKind ? { discountKind } : {}),
  }
}

const DISCOUNT_KINDS: readonly PriceDiscountKind[] = [
  'length_of_stay',
  'early_booking',
  'last_minute',
  'rate_plan',
  'discount_code',
]

function priceLines(value: unknown, path: string): readonly PriceLine[] {
  return list(value, path, 4096).map((entry, index) => priceLine(entry, `${path}[${index}]`))
}

function propertyPresentation(value: unknown, path: string): PropertyPresentation {
  const source = record(value, path)
  const locality = at(source, 'locality')
  const description = at(source, 'description')
  return {
    locality: locality === null ? null : text(locality, `${path}.locality`, 1, 120),
    description: description === null ? null : text(description, `${path}.description`, 1, 400),
    images: list(at(source, 'images'), `${path}.images`, 20).map((image, index) =>
      mediaImage(image, `${path}.images[${index}]`),
    ),
    // 0.4.0, read tolerantly: an API from before these fields answers none.
    location: (() => {
      const location = at(source, 'location')
      return location === undefined || location === null ? null : text(location, `${path}.location`, 1, 1000)
    })(),
    amenities: amenities(at(source, 'amenities'), `${path}.amenities`),
    faq: (() => {
      const faq = at(source, 'faq')
      return faq === undefined
        ? []
        : list(faq, `${path}.faq`, 10).map((entry, index) => {
            const item = record(entry, `${path}.faq[${index}]`)
            return {
              question: text(at(item, 'question'), `${path}.faq[${index}].question`, 1, 200),
              answer: text(at(item, 'answer'), `${path}.faq[${index}].answer`, 1, 1000),
            }
          })
    })(),
  }
}

function amenities(value: unknown, path: string): readonly string[] {
  if (value === undefined) return []
  return list(value, path, 40).map((code, index) =>
    matches(code, `${path}[${index}]`, /^[a-z][a-z_]{1,39}$/, 'must be an amenity code'),
  )
}

function mediaImage(value: unknown, path: string): UnitPresentation['images'][number] {
  const source = record(value, path)
  const assetKey = matches(
    at(source, 'assetKey'),
    `${path}.assetKey`,
    /^[a-z0-9][a-z0-9-]{2,63}$/,
    'must be a lower-case asset key',
  )
  const variantsSource = record(at(source, 'variants'), `${path}.variants`)
  const variant = (name: 'thumbnail' | 'small' | 'medium' | 'large') => {
    const scope = `${path}.variants.${name}`
    const entry = record(at(variantsSource, name), scope)
    return {
      url: matches(
        at(entry, 'url'),
        `${scope}.url`,
        /^\/media\/[a-z0-9][a-z0-9-]{2,63}\/(thumbnail|small|medium|large)\.webp$/,
        'must be a media path',
      ),
      width: integer(at(entry, 'width'), `${scope}.width`, 1, 10_000),
      height: integer(at(entry, 'height'), `${scope}.height`, 1, 10_000),
    }
  }
  return {
    assetKey,
    alt: text(at(source, 'alt'), `${path}.alt`, 1, 160),
    role: member(at(source, 'role'), `${path}.role`, ['cover', 'gallery'] as const),
    sortOrder: integer(at(source, 'sortOrder'), `${path}.sortOrder`, 0, 19),
    width: integer(at(source, 'width'), `${path}.width`, 1, 10_000),
    height: integer(at(source, 'height'), `${path}.height`, 1, 10_000),
    url: matches(
      at(source, 'url'),
      `${path}.url`,
      new RegExp(`^/media/${assetKey}/medium\\.webp$`),
      'must be the medium media path',
    ),
    variants: {
      thumbnail: variant('thumbnail'),
      small: variant('small'),
      medium: variant('medium'),
      large: variant('large'),
    },
  }
}

function unitPresentation(value: unknown, path: string): UnitPresentation {
  const source = record(value, path)
  const description = at(source, 'description')
  // 0.12.0, read tolerantly: the floor area, absent from an API before it and when the host gave none.
  const floorArea = at(source, 'floorArea')
  return {
    description: description === null ? null : text(description, `${path}.description`, 1, 400),
    sleepingArrangement: list(at(source, 'sleepingArrangement'), `${path}.sleepingArrangement`, 8).map(
      (space, index) => {
        const scope = `${path}.sleepingArrangement[${index}]`
        const entry = record(space, scope)
        return {
          kind: member(at(entry, 'kind'), `${scope}.kind`, ['bedroom', 'living_room'] as const),
          beds: list(at(entry, 'beds'), `${scope}.beds`, 4).map((bed, bedIndex) => {
            const bedScope = `${scope}.beds[${bedIndex}]`
            const source2 = record(bed, bedScope)
            return {
              kind: member(at(source2, 'kind'), `${bedScope}.kind`, ['double', 'single', 'sofa_bed', 'bunk'] as const),
              count: integer(at(source2, 'count'), `${bedScope}.count`, 1, 8),
            }
          }),
        }
      },
    ),
    amenities: amenities(at(source, 'amenities'), `${path}.amenities`),
    images: list(at(source, 'images'), `${path}.images`, 20).map((image, index) =>
      mediaImage(image, `${path}.images[${index}]`),
    ),
    ...(floorArea === undefined ? {} : { floorArea: integer(floorArea, `${path}.floorArea`, 1, 2000) }),
  }
}

function nullableText(value: unknown, path: string, min: number, max: number): string | null {
  return value === null ? null : text(value, path, min, max)
}

function host(value: unknown, path: string): Host {
  const source = record(value, path)
  return {
    name: nullableText(at(source, 'name'), `${path}.name`, 1, 120),
    email: nullableText(at(source, 'email'), `${path}.email`, 3, 254),
    phone: nullableText(at(source, 'phone'), `${path}.phone`, 5, 30),
  }
}

function legalDocument(value: unknown, path: string): LegalDocument | null {
  if (value === null) return null
  const source = record(value, path)
  const kind = member(at(source, 'kind'), `${path}.kind`, ['link', 'text'] as const)
  if (kind === 'link')
    return { kind, url: matches(at(source, 'url'), `${path}.url`, /^https:\/\/\S{1,492}$/, 'must be an https link') }
  return { kind, text: text(at(source, 'text'), `${path}.text`, 1, 30_000) }
}

function legal(value: unknown, path: string): Legal {
  const source = record(value, path)
  const cancellation = at(source, 'cancellation')
  const terms = cancellation === null ? null : record(cancellation, `${path}.cancellation`)
  return {
    imprint: legalDocument(at(source, 'imprint'), `${path}.imprint`),
    privacy: legalDocument(at(source, 'privacy'), `${path}.privacy`),
    cancellation:
      terms === null
        ? null
        : {
            version: integer(at(terms, 'version'), `${path}.cancellation.version`, 1, Number.MAX_SAFE_INTEGER),
            freeCancellationDays: integer(
              at(terms, 'freeCancellationDays'),
              `${path}.cancellation.freeCancellationDays`,
              0,
              365,
            ),
            lateRefundBasisPoints: integer(
              at(terms, 'lateRefundBasisPoints'),
              `${path}.cancellation.lateRefundBasisPoints`,
              0,
              10_000,
            ),
            testOnly: boolean(at(terms, 'testOnly'), `${path}.cancellation.testOnly`),
          },
  }
}

export function parseBookingProperty(value: unknown): BookingProperty {
  const source = record(value, '')
  const presentation = at(source, 'presentation')
  const shortId = at(source, 'shortId')
  const hostContent = at(source, 'host')
  const legalContent = at(source, 'legal')
  const checkInTime = at(source, 'checkInTime')
  const checkOutTime = at(source, 'checkOutTime')
  const businessProfile = at(source, 'businessProfile')
  const testMode = at(source, 'testMode')
  const noIndex = at(source, 'noIndex')
  const discountCodes = at(source, 'discountCodes')
  const onlineBooking = at(source, 'onlineBooking')
  const ratePlans = at(source, 'ratePlans')
  const localTime = (time: unknown, path: string) =>
    time === null ? null : matches(time, path, LOCAL_TIME, 'must be a local time in HH:MM form')
  const units = list(at(source, 'units'), 'units', 512).map((unit, index): BookingUnit => {
    const scope = `units[${index}]`
    const entry = record(unit, scope)
    const unitContent = at(entry, 'presentation')
    const leadPrice = at(entry, 'leadPrice')
    const extras = at(entry, 'extras')
    return {
      publicUnitReference: matches(
        at(entry, 'publicUnitReference'),
        `${scope}.publicUnitReference`,
        PUBLIC_REFERENCE,
        'must be a public reference',
      ),
      displayName: text(at(entry, 'displayName'), `${scope}.displayName`, 1, 160),
      maxOccupancy: integer(at(entry, 'maxOccupancy'), `${scope}.maxOccupancy`, 1, 20),
      ...(unitContent === undefined ? {} : { presentation: unitPresentation(unitContent, `${scope}.presentation`) }),
      ...(leadPrice === undefined
        ? {}
        : { leadPrice: leadPrice === null ? null : money(leadPrice, `${scope}.leadPrice`) }),
      // 0.6.0, read tolerantly: an API from before extras answers none.
      ...(extras === undefined
        ? {}
        : {
            extras: list(extras, `${scope}.extras`, 10).map((offered, extraIndex) => {
              const path = `${scope}.extras[${extraIndex}]`
              const extra = record(offered, path)
              return {
                id: matches(at(extra, 'id'), `${path}.id`, /^[a-z0-9-]{1,40}$/, 'must be an extra id'),
                name: text(at(extra, 'name'), `${path}.name`, 1, 60),
                pricing: member(at(extra, 'pricing'), `${path}.pricing`, [
                  'per_stay',
                  'per_night',
                  'per_person_night',
                ] as const),
                amount: money(at(extra, 'amount'), `${path}.amount`),
              }
            }),
          }),
    }
  })
  return {
    publicPropertyId: matches(
      at(source, 'publicPropertyId'),
      'publicPropertyId',
      PUBLIC_REFERENCE,
      'must be a public reference',
    ),
    ...(shortId === undefined
      ? {}
      : { shortId: matches(shortId, 'shortId', SHORT_ID, 'must be eight characters of the short alphabet') }),
    displayName: text(at(source, 'displayName'), 'displayName', 1, 160),
    locale: text(at(source, 'locale'), 'locale', 2, 35),
    timezone: text(at(source, 'timezone'), 'timezone', 1, 100),
    currency: matches(at(source, 'currency'), 'currency', /^[A-Z]{3}$/, 'must be an ISO currency code'),
    ...(presentation === undefined ? {} : { presentation: propertyPresentation(presentation, 'presentation') }),
    ...(hostContent === undefined ? {} : { host: host(hostContent, 'host') }),
    ...(legalContent === undefined ? {} : { legal: legal(legalContent, 'legal') }),
    ...(checkInTime === undefined ? {} : { checkInTime: localTime(checkInTime, 'checkInTime') }),
    ...(checkOutTime === undefined ? {} : { checkOutTime: localTime(checkOutTime, 'checkOutTime') }),
    // 0.4.0, a plain string so a kind added later still reads.
    ...(businessProfile === undefined ? {} : { businessProfile: text(businessProfile, 'businessProfile', 1, 40) }),
    ...(testMode === undefined ? {} : { testMode: literalTrue(testMode, 'testMode') }),
    // 0.16.0: the host's payments are not set up, so no checkout can start.
    ...(onlineBooking === undefined ? {} : { onlineBooking: literalFalse(onlineBooking, 'onlineBooking') }),
    // 0.5.0: the host keeps the page out of search engines.
    ...(noIndex === undefined ? {} : { noIndex: literalTrue(noIndex, 'noIndex') }),
    ...(discountCodes === undefined ? {} : { discountCodes: literalTrue(discountCodes, 'discountCodes') }),
    // 0.8.0, read tolerantly: an API from before rate plans sends none.
    ...(ratePlans === undefined
      ? {}
      : {
          ratePlans: list(ratePlans, 'ratePlans', 10).map((entry, index) => {
            const path = `ratePlans[${index}]`
            const plan = record(entry, path)
            const freeDays = at(plan, 'freeCancellationDays')
            return {
              ratePlan: matches(at(plan, 'ratePlan'), `${path}.ratePlan`, RATE_PLAN, 'must be a rate plan reference'),
              name: text(at(plan, 'name'), `${path}.name`, 1, 60),
              discountBasisPoints: integer(at(plan, 'discountBasisPoints'), `${path}.discountBasisPoints`, 0, 9_000),
              freeCancellationDays:
                freeDays === null ? null : integer(freeDays, `${path}.freeCancellationDays`, 0, 365),
              lateRefundBasisPoints: integer(
                at(plan, 'lateRefundBasisPoints'),
                `${path}.lateRefundBasisPoints`,
                0,
                10_000,
              ),
              excludedUnits: list(at(plan, 'excludedUnits'), `${path}.excludedUnits`, 512).map((reference, unitIndex) =>
                matches(
                  reference,
                  `${path}.excludedUnits[${unitIndex}]`,
                  PUBLIC_REFERENCE,
                  'must be a public reference',
                ),
              ),
            }
          }),
        }),
    units,
  }
}

export function parseAvailability(value: unknown): Availability {
  const source = record(value, '')
  return {
    asOf: instant(at(source, 'asOf'), 'asOf'),
    inventoryGuarantee: member(at(source, 'inventoryGuarantee'), 'inventoryGuarantee', ['none'] as const),
    offers: list(at(source, 'offers'), 'offers', 512).map((offer, index): AvailabilityOffer => {
      const scope = `offers[${index}]`
      const entry = record(offer, scope)
      const preview = record(at(entry, 'pricePreview'), `${scope}.pricePreview`)
      return {
        publicUnitReference: matches(
          at(entry, 'publicUnitReference'),
          `${scope}.publicUnitReference`,
          PUBLIC_REFERENCE,
          'must be a public reference',
        ),
        displayName: text(at(entry, 'displayName'), `${scope}.displayName`, 1, 160),
        maxOccupancy: integer(at(entry, 'maxOccupancy'), `${scope}.maxOccupancy`, 1, 20),
        stay: stay(at(entry, 'stay'), `${scope}.stay`),
        occupancy: occupancy(at(entry, 'occupancy'), `${scope}.occupancy`),
        pricePreview: {
          total: money(at(preview, 'total'), `${scope}.pricePreview.total`),
          lineItems: priceLines(at(preview, 'lineItems'), `${scope}.pricePreview.lineItems`),
        },
      }
    }),
  }
}

export function parseAvailabilityCalendar(value: unknown): AvailabilityCalendar {
  const source = record(value, '')
  return {
    asOf: instant(at(source, 'asOf'), 'asOf'),
    inventoryGuarantee: member(at(source, 'inventoryGuarantee'), 'inventoryGuarantee', ['none'] as const),
    occupancy: occupancy(at(source, 'occupancy'), 'occupancy'),
    nights: list(at(source, 'nights'), 'nights', 62).map((night, index) => {
      const scope = `nights[${index}]`
      const entry = record(night, scope)
      const fromPrice = at(entry, 'fromPrice')
      const minimumStayNights = at(entry, 'minimumStayNights')
      const available = boolean(at(entry, 'available'), `${scope}.available`)
      // Stay rules (added later): an API that does not send them takes every arrival and departure, with no maximum.
      const arrivalAllowed = at(entry, 'arrivalAllowed')
      const maximumStayNights = at(entry, 'maximumStayNights')
      const departureAllowed = at(entry, 'departureAllowed')
      return {
        date: calendarDay(at(entry, 'date'), `${scope}.date`),
        available,
        fromPrice: fromPrice === null ? null : money(fromPrice, `${scope}.fromPrice`),
        minimumStayNights:
          minimumStayNights === null ? null : integer(minimumStayNights, `${scope}.minimumStayNights`, 1, 3650),
        arrivalAllowed:
          arrivalAllowed === undefined
            ? available || null
            : arrivalAllowed === null
              ? null
              : boolean(arrivalAllowed, `${scope}.arrivalAllowed`),
        maximumStayNights:
          maximumStayNights === undefined || maximumStayNights === null
            ? null
            : integer(maximumStayNights, `${scope}.maximumStayNights`, 1, 3650),
        departureAllowed:
          departureAllowed === undefined ? true : boolean(departureAllowed, `${scope}.departureAllowed`),
      }
    }),
  }
}

export function parseQuote(value: unknown): Quote {
  const source = record(value, '')
  const unit = record(at(source, 'unit'), 'unit')
  const cancellation = at(source, 'cancellation')
  const terms = cancellation === undefined ? undefined : record(cancellation, 'cancellation')
  const freeUntil = terms === undefined ? undefined : at(terms, 'freeUntil')
  // 0.8.0, read tolerantly: the bound terms and the rate, absent from an API before rate plans.
  const freeDays = terms === undefined ? undefined : at(terms, 'freeCancellationDays')
  const lateShare = terms === undefined ? undefined : at(terms, 'lateRefundBasisPoints')
  const ratePlan = at(source, 'ratePlan')
  // 0.7.0, read tolerantly: an API from before the tourist tax sends nothing.
  const onSite = at(source, 'payableOnSite')
  // 0.10.0, read tolerantly: the rest after a deposit.
  const balance = at(source, 'balance')
  // 0.15.0, read tolerantly: the stay's total at every rate offered.
  const totals = at(source, 'ratePlanTotals')
  // 0.17.0, read tolerantly: the host's discount code the quote was priced with.
  const code = at(source, 'discountCode')
  if (at(source, 'authoritative') !== true) fail('authoritative', 'must be true')
  return {
    publicQuoteReference: matches(
      at(source, 'publicQuoteReference'),
      'publicQuoteReference',
      PUBLIC_REFERENCE,
      'must be a public reference',
    ),
    expiresAt: instant(at(source, 'expiresAt'), 'expiresAt'),
    unit: {
      publicUnitReference: matches(
        at(unit, 'publicUnitReference'),
        'unit.publicUnitReference',
        PUBLIC_REFERENCE,
        'must be a public reference',
      ),
      displayName: text(at(unit, 'displayName'), 'unit.displayName', 1, 160),
    },
    stay: stay(at(source, 'stay'), 'stay'),
    occupancy: occupancy(at(source, 'occupancy'), 'occupancy'),
    total: money(at(source, 'total'), 'total'),
    dueNow: money(at(source, 'dueNow'), 'dueNow'),
    lineItems: priceLines(at(source, 'lineItems'), 'lineItems'),
    authoritative: true,
    ...(cancellation === undefined
      ? {}
      : {
          cancellation: {
            freeUntil: freeUntil === null ? null : calendarDay(freeUntil, 'cancellation.freeUntil'),
            ...(freeDays === undefined
              ? {}
              : {
                  freeCancellationDays:
                    freeDays === null ? null : integer(freeDays, 'cancellation.freeCancellationDays', 0, 365),
                }),
            ...(lateShare === undefined
              ? {}
              : { lateRefundBasisPoints: integer(lateShare, 'cancellation.lateRefundBasisPoints', 0, 10_000) }),
          },
        }),
    ...(ratePlan === undefined
      ? {}
      : {
          ratePlan: {
            ratePlan: matches(
              at(record(ratePlan, 'ratePlan'), 'ratePlan'),
              'ratePlan.ratePlan',
              RATE_PLAN,
              'must be a rate plan reference',
            ),
            name: text(at(record(ratePlan, 'ratePlan'), 'name'), 'ratePlan.name', 1, 60),
          },
        }),
    ...(code === undefined
      ? {}
      : {
          discountCode: {
            code: text(at(record(code, 'discountCode'), 'code'), 'discountCode.code', 6, 24),
            applied: boolean(at(record(code, 'discountCode'), 'applied'), 'discountCode.applied'),
          },
        }),
    ...(onSite === undefined
      ? {}
      : {
          payableOnSite: list(onSite, 'payableOnSite', 1).map((entry, index) => {
            const item = record(entry, `payableOnSite[${index}]`)
            return {
              kind: member(at(item, 'kind'), `payableOnSite[${index}].kind`, ['tourist_tax'] as const),
              amount: money(at(item, 'amount'), `payableOnSite[${index}].amount`),
            }
          }),
        }),
    ...(balance === undefined ? {} : { balance: balanceOf(balance) }),
    ...(totals === undefined
      ? {}
      : {
          ratePlanTotals: list(totals, 'ratePlanTotals', 11).map((entry, index) => {
            const item = record(entry, `ratePlanTotals[${index}]`)
            const plan = at(item, 'ratePlan')
            return {
              ratePlan:
                plan === null
                  ? null
                  : matches(plan, `ratePlanTotals[${index}].ratePlan`, RATE_PLAN, 'must be a rate plan reference'),
              total: money(at(item, 'total'), `ratePlanTotals[${index}].total`),
            }
          }),
        }),
  }
}

/** 0.10.0: the rest after a deposit and the property-local day it is charged. */
function balanceOf(value: unknown): { readonly amount: Money; readonly dueOn: string } {
  const source = record(value, 'balance')
  return {
    amount: money(at(source, 'amount'), 'balance.amount'),
    dueOn: calendarDay(at(source, 'dueOn'), 'balance.dueOn'),
  }
}

export function parseCheckout(value: unknown): Checkout {
  const source = record(value, '')
  return {
    publicCheckoutReference: matches(
      at(source, 'publicCheckoutReference'),
      'publicCheckoutReference',
      PUBLIC_REFERENCE,
      'must be a public reference',
    ),
    expiresAt: instant(at(source, 'expiresAt'), 'expiresAt'),
    checkoutState: member(at(source, 'checkoutState'), 'checkoutState', [
      'awaiting_payment',
      'requires_customer_action',
    ] as const),
    paymentState: member(at(source, 'paymentState'), 'paymentState', [
      'created',
      'requires_customer_action',
      'processing',
    ] as const),
    reservationState: member(at(source, 'reservationState'), 'reservationState', ['pending'] as const),
    safeNextAction: member(at(source, 'safeNextAction'), 'safeNextAction', ['wait', 'complete_payment'] as const),
  }
}

export function parseCheckoutStatus(value: unknown): CheckoutStatus {
  const source = record(value, '')
  const property = record(at(source, 'property'), 'property')
  const unit = record(at(source, 'unit'), 'unit')
  const paymentUi = record(at(source, 'paymentUi'), 'paymentUi')
  const confirmation = at(source, 'confirmationReference')
  const reservationNumber = at(source, 'reservationNumber')
  const retryAfter = at(source, 'retryAfter')
  const support = at(source, 'supportReference')
  const paymentPreparing = at(source, 'paymentPreparing')
  const heldUntil = at(source, 'heldUntil')
  const confirmationMail = at(source, 'confirmationMail')
  const changedAt = at(source, 'changedAt')
  // 0.13.0, read tolerantly: what became of the booking and what was refunded, absent from an API before them.
  const bookingState = at(source, 'bookingState')
  const cancelledAt = at(source, 'cancelledAt')
  const cancelledBy = at(source, 'cancelledBy')
  const refund = at(source, 'refund')
  // 0.12.0, read tolerantly: the guest portal link, absent from an API before it.
  const guestPortalUrl = at(source, 'guestPortalUrl')
  // 0.9.0, read tolerantly: the rate and the bound terms, absent from an API before them.
  const ratePlan = at(source, 'ratePlan')
  const cancellation = at(source, 'cancellation')
  const terms = cancellation === undefined ? undefined : record(cancellation, 'cancellation')
  const freeDays = terms === undefined ? undefined : at(terms, 'freeCancellationDays')
  const freeUntil = terms === undefined ? undefined : at(terms, 'freeUntil')
  // 0.10.0, read tolerantly: the deposit and the rest.
  const deposit = at(source, 'deposit')
  const balance = at(source, 'balance')
  return {
    publicCheckoutReference: matches(
      at(source, 'publicCheckoutReference'),
      'publicCheckoutReference',
      PUBLIC_REFERENCE,
      'must be a public reference',
    ),
    expiresAt: instant(at(source, 'expiresAt'), 'expiresAt'),
    property: {
      publicPropertyId: matches(
        at(property, 'publicPropertyId'),
        'property.publicPropertyId',
        PUBLIC_REFERENCE,
        'must be a public reference',
      ),
      displayName: text(at(property, 'displayName'), 'property.displayName', 1, 160),
    },
    unit: {
      publicUnitReference: matches(
        at(unit, 'publicUnitReference'),
        'unit.publicUnitReference',
        PUBLIC_REFERENCE,
        'must be a public reference',
      ),
      displayName: text(at(unit, 'displayName'), 'unit.displayName', 1, 160),
    },
    stay: stay(at(source, 'stay'), 'stay'),
    occupancy: occupancy(at(source, 'occupancy'), 'occupancy'),
    total: money(at(source, 'total'), 'total'),
    lineItems: priceLines(at(source, 'lineItems'), 'lineItems'),
    checkoutState: member(at(source, 'checkoutState'), 'checkoutState', [
      'awaiting_payment',
      'requires_customer_action',
      'processing',
      'resolving',
      'completed',
      'expired',
      'failed',
      'needs_attention',
    ] as const),
    paymentState: member(at(source, 'paymentState'), 'paymentState', [
      'created',
      'requires_customer_action',
      'processing',
      'succeeded',
      'failed',
      'cancelled',
    ] as const),
    reservationState: member(at(source, 'reservationState'), 'reservationState', [
      'pending',
      'confirmed',
      'not_confirmed',
      'recovery_required',
    ] as const),
    ...(confirmation === undefined
      ? {}
      : {
          confirmationReference: matches(
            confirmation,
            'confirmationReference',
            CONFIRMATION_REFERENCE,
            'must be twelve upper-case alphanumerics',
          ),
        }),
    ...(reservationNumber === undefined
      ? {}
      : { reservationNumber: integer(reservationNumber, 'reservationNumber', 1001, 2_147_483_647) }),
    paymentUi: {
      kind: member(at(paymentUi, 'kind'), 'paymentUi.kind', [
        'stripe_embedded_checkout',
        'stripe_checkout_elements',
        'none',
      ] as const),
    },
    safeNextAction: member(at(source, 'safeNextAction'), 'safeNextAction', [
      'wait',
      'complete_payment',
      'start_new_search',
      'booking_confirmed',
      'contact_support',
      'none',
    ] as const),
    ...(retryAfter === undefined ? {} : { retryAfter: integer(retryAfter, 'retryAfter', 1, 86_400) }),
    ...(support === undefined
      ? {}
      : { supportReference: matches(support, 'supportReference', PUBLIC_REFERENCE, 'must be a public reference') }),
    ...(paymentPreparing === undefined ? {} : { paymentPreparing: boolean(paymentPreparing, 'paymentPreparing') }),
    ...(heldUntil === undefined ? {} : { heldUntil: heldUntil === null ? null : instant(heldUntil, 'heldUntil') }),
    ...(confirmationMail === undefined
      ? {}
      : {
          confirmationMail:
            confirmationMail === null
              ? null
              : member(confirmationMail, 'confirmationMail', ['pending', 'sent', 'failed', 'unknown'] as const),
        }),
    ...(changedAt === undefined ? {} : { changedAt: changedAt === null ? null : instant(changedAt, 'changedAt') }),
    ...(bookingState === undefined
      ? {}
      : {
          bookingState:
            bookingState === null
              ? null
              : member(bookingState, 'bookingState', ['confirmed', 'cancelled', 'no_show'] as const),
        }),
    ...(cancelledAt === undefined
      ? {}
      : { cancelledAt: cancelledAt === null ? null : instant(cancelledAt, 'cancelledAt') }),
    ...(cancelledBy === undefined
      ? {}
      : { cancelledBy: cancelledBy === null ? null : member(cancelledBy, 'cancelledBy', ['guest', 'host'] as const) }),
    ...(refund === undefined ? {} : { refund: refund === null ? null : refundOf(refund) }),
    ...(guestPortalUrl === undefined
      ? {}
      : {
          // A link the SDK does not recognise is dropped, never followed, and never fails the booking's outcome.
          guestPortalUrl: typeof guestPortalUrl === 'string' && PORTAL_URL.test(guestPortalUrl) ? guestPortalUrl : null,
        }),
    ...(ratePlan === undefined
      ? {}
      : {
          ratePlan: {
            ratePlan: matches(
              at(record(ratePlan, 'ratePlan'), 'ratePlan'),
              'ratePlan.ratePlan',
              RATE_PLAN,
              'must be a rate plan reference',
            ),
            name: text(at(record(ratePlan, 'ratePlan'), 'name'), 'ratePlan.name', 1, 60),
          },
        }),
    ...(terms === undefined
      ? {}
      : {
          cancellation: {
            freeUntil: freeUntil === null ? null : calendarDay(freeUntil, 'cancellation.freeUntil'),
            freeCancellationDays:
              freeDays === null ? null : integer(freeDays, 'cancellation.freeCancellationDays', 0, 365),
            lateRefundBasisPoints: integer(
              at(terms, 'lateRefundBasisPoints'),
              'cancellation.lateRefundBasisPoints',
              0,
              10_000,
            ),
          },
        }),
    ...(deposit === undefined ? {} : { deposit: money(deposit, 'deposit') }),
    ...(balance === undefined ? {} : { balance: balanceOf(balance) }),
  }
}

/** 0.13.0: the money returned to the guest; its state is a closed enumeration like the booking's own states. */
function refundOf(value: unknown): Refund {
  const source = record(value, 'refund')
  return {
    amount: money(at(source, 'amount'), 'refund.amount'),
    refunded: money(at(source, 'refunded'), 'refund.refunded'),
    state: member(at(source, 'state'), 'refund.state', ['pending', 'succeeded', 'failed'] as const),
  }
}

export function parsePaymentSession(value: unknown): PaymentSession {
  const source = record(value, '')
  return {
    kind: member(at(source, 'kind'), 'kind', ['stripe_embedded_checkout', 'stripe_checkout_elements'] as const),
    publishableKey: text(at(source, 'publishableKey'), 'publishableKey', 1, 255),
    accountId: text(at(source, 'accountId'), 'accountId', 1, 255),
    clientSecret: text(at(source, 'clientSecret'), 'clientSecret', 1, 2048),
    expiresAt: instant(at(source, 'expiresAt'), 'expiresAt'),
  }
}

const KNOWN_PROBLEM_CODES = [
  'AUTHENTICATION_REQUIRED',
  'PERMISSION_DENIED',
  'VERSION_CONFLICT',
  'PREVIEW_STALE',
  'POLICY_MISSING',
  'NOT_CANCELLABLE',
  'NOT_FOUND',
  'INVALID_REQUEST',
  'INVENTORY_CONFLICT',
  'BOOKING_NOT_AVAILABLE',
  'INVALID_BOOKING_DETAILS',
  'TOO_MANY_REQUESTS',
  'QUOTE_EXPIRED',
  'IDEMPOTENCY_KEY_REUSED',
  'APARTMENT_NO_LONGER_AVAILABLE',
  'CHECKOUT_EXPIRED',
  'PAYMENT_SESSION_UNAVAILABLE',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
  'IDEMPOTENCY_IN_PROGRESS',
  'IDEMPOTENCY_OUTCOME_UNKNOWN',
] as const satisfies readonly Exclude<BookingErrorCode, 'UNRECOGNIZED_PROBLEM'>[]

/**
 * A code this SDK does not know yet is a generic failure, not an unreadable answer. The server
 * adds codes without a new contract version; the problem keeps its status and `retryable`, and `serverCode` says what
 * the server sent. Anything that is not a code at all still makes the document unreadable.
 */
function problemCode(value: unknown): Pick<BookingProblem, 'code' | 'serverCode'> {
  const known = KNOWN_PROBLEM_CODES.find((code) => code === value)
  if (known) return { code: known }
  if (typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value))
    return { code: 'UNRECOGNIZED_PROBLEM', serverCode: value }
  throw new ShapeError('code', 'is not a problem code')
}

/** A problem document. Returns `undefined` rather than throwing, so an unrecognisable error body stays a transport
 * failure instead of masking the original one. */
export function readProblem(value: unknown): BookingProblem | undefined {
  try {
    const source = record(value, '')
    const retryAfter = at(source, 'retryAfter')
    return {
      type: member(at(source, 'type'), 'type', ['about:blank'] as const),
      title: text(at(source, 'title'), 'title', 1, 120),
      status: integer(at(source, 'status'), 'status', 400, 599),
      ...problemCode(at(source, 'code')),
      retryable: boolean(at(source, 'retryable'), 'retryable'),
      ...(retryAfter === undefined ? {} : { retryAfter: integer(retryAfter, 'retryAfter', 1, 86_400) }),
      ...stayRuleOf(at(source, 'stayRule')),
      ...unavailableOf(at(source, 'unavailable')),
      // 0.17.0: a code that does not count; anything else there is ignored, never fatal.
      ...(at(source, 'discountCode') === 'not_valid' ? { discountCode: 'not_valid' as const } : {}),
    }
  } catch {
    return undefined
  }
}

/** The notice of a page that takes no booking, or nothing: an unreadable one never makes the problem unreadable. */
function unavailableOf(value: unknown): Pick<BookingProblem, 'unavailable'> {
  if (value === undefined) return {}
  try {
    const source = record(value, 'unavailable')
    const shortId = at(source, 'shortId')
    return {
      unavailable: {
        state: member(at(source, 'state'), 'unavailable.state', ['paused', 'empty'] as const),
        publicPropertyId: text(at(source, 'publicPropertyId'), 'unavailable.publicPropertyId', 1, 64),
        ...(shortId === undefined ? {} : { shortId: text(shortId, 'unavailable.shortId', 1, 16) }),
        displayName: text(at(source, 'displayName'), 'unavailable.displayName', 1, 160),
        host: host(at(source, 'host'), 'unavailable.host'),
        legal: legal(at(source, 'legal'), 'unavailable.legal'),
      },
    }
  } catch {
    return {}
  }
}

/** The stay-rule detail of a problem, or nothing: an unreadable detail never makes the problem itself unreadable. */
function stayRuleOf(value: unknown): Pick<BookingProblem, 'stayRule'> {
  if (value === undefined) return {}
  try {
    const source = record(value, 'stayRule')
    const requiredNights = at(source, 'requiredNights')
    const maximumNights = at(source, 'maximumNights')
    const allowedDays = at(source, 'allowedDays')
    return {
      stayRule: {
        reason: member(at(source, 'reason'), 'stayRule.reason', [
          'minimum_stay_not_satisfied',
          'maximum_stay_exceeded',
          'arrival_day_not_allowed',
          'departure_day_not_allowed',
        ] as const),
        ...(requiredNights === undefined
          ? {}
          : { requiredNights: integer(requiredNights, 'stayRule.requiredNights', 1, 3_650) }),
        ...(maximumNights === undefined
          ? {}
          : { maximumNights: integer(maximumNights, 'stayRule.maximumNights', 1, 3_650) }),
        ...(allowedDays === undefined || !Array.isArray(allowedDays)
          ? {}
          : {
              allowedDays: allowedDays.map((day, index) => integer(day, `stayRule.allowedDays.${index}`, 1, 7)),
            }),
      },
    }
  } catch {
    return {}
  }
}

/** A public reference: property, unit, quote or checkout. */
export function assertReference(value: string, path: string): void {
  matches(value, path, PUBLIC_REFERENCE, 'must be a public reference')
}

export function assertIdempotencyKey(value: string): void {
  matches(value, 'idempotencyKey', IDEMPOTENCY_KEY, 'must be 16..128 characters of A-Z a-z 0-9 _ -')
}

/**
 * Request checks. Deliberately permissive: they refuse only what the API is certain to refuse, so no request the API
 * would have accepted is blocked here.
 */
export function assertAvailabilityRequest(input: AvailabilityRequest): void {
  calendarDay(input.checkIn, 'checkIn')
  calendarDay(input.checkOut, 'checkOut')
  if (input.checkOut <= input.checkIn) fail('checkOut', 'must be after checkIn')
  occupancy(input.occupancy, 'occupancy')
}

/** Only the shape; whether `from` is today or later is the API's decision, in the property's own calendar. */
export function assertAvailabilityCalendarRequest(input: AvailabilityCalendarRequest): void {
  calendarDay(input.from, 'from')
  integer(input.nights, 'nights', 1, 62)
  occupancy(input.occupancy, 'occupancy')
  // 0.12.0: one apartment, when one is named.
  if (input.publicUnitReference !== undefined) assertReference(input.publicUnitReference, 'publicUnitReference')
}

export function assertQuoteRequest(input: QuoteRequest): void {
  assertReference(input.publicUnitReference, 'publicUnitReference')
  calendarDay(input.checkIn, 'checkIn')
  calendarDay(input.checkOut, 'checkOut')
  if (input.checkOut <= input.checkIn) fail('checkOut', 'must be after checkIn')
  occupancy(input.occupancy, 'occupancy')
  // 0.8.0: a rate plan reference, when one is chosen.
  if (input.ratePlan !== undefined) matches(input.ratePlan, 'ratePlan', RATE_PLAN, 'must be a rate plan reference')
  // 0.17.0: the code as typed; the server normalises and judges it.
  if (input.discountCode !== undefined) text(input.discountCode, 'discountCode', 1, 40)
}

/**
 * Validates a checkout request restored from your own storage, returning `undefined` when it is not usable.
 *
 * This exists for the durable-idempotency rule: an intent has to be persisted before the first attempt, which means
 * it has to be read back after a reload or a process restart, and a half-written intent must never be dispatched.
 */
export function parseCheckoutRequest(value: unknown): CheckoutRequest | undefined {
  try {
    const source = record(value, '')
    const contact = record(at(source, 'bookingContact'), 'bookingContact')
    const acceptance = record(at(source, 'acceptance'), 'acceptance')
    const candidate: CheckoutRequest = {
      publicQuoteReference: matches(
        at(source, 'publicQuoteReference'),
        'publicQuoteReference',
        PUBLIC_REFERENCE,
        'must be a public reference',
      ),
      bookingContact: {
        firstName: text(at(contact, 'firstName'), 'bookingContact.firstName', 1, 100),
        lastName: text(at(contact, 'lastName'), 'bookingContact.lastName', 1, 100),
        email: text(at(contact, 'email'), 'bookingContact.email', 3, 254),
      },
      acceptance: {
        termsVersion: text(at(acceptance, 'termsVersion'), 'acceptance.termsVersion', 1, 100),
        cancellationPolicyVersion: text(
          at(acceptance, 'cancellationPolicyVersion'),
          'acceptance.cancellationPolicyVersion',
          1,
          100,
        ),
        privacyNoticeVersion: text(at(acceptance, 'privacyNoticeVersion'), 'acceptance.privacyNoticeVersion', 1, 100),
        accepted: true,
      },
    }
    if (at(acceptance, 'accepted') !== true) return undefined
    // 0.4.0: an intent stored before the language existed reads back without one.
    const language = at(source, 'language')
    if (language !== undefined && language !== 'de' && language !== 'en') return undefined
    const withLanguage: CheckoutRequest = language === undefined ? candidate : { ...candidate, language }
    // 0.12.0: likewise the return address.
    const returnUrl = at(source, 'returnUrl')
    const withReturn: CheckoutRequest =
      returnUrl === undefined ? withLanguage : { ...withLanguage, returnUrl: returnAddress(returnUrl) }
    // 0.14.0: and the payment form.
    const paymentUi = at(source, 'paymentUi')
    const restored: CheckoutRequest =
      paymentUi === undefined
        ? withReturn
        : {
            ...withReturn,
            paymentUi: member(paymentUi, 'paymentUi', [
              'stripe_embedded_checkout',
              'stripe_checkout_elements',
            ] as const),
          }
    assertCheckoutRequest(restored)
    return restored
  } catch {
    return undefined
  }
}

/** True when a value is a usable idempotency key. Use it when reading one back from your own storage. */
export function isIdempotencyKey(value: unknown): boolean {
  return typeof value === 'string' && IDEMPOTENCY_KEY.test(value)
}

export function assertCheckoutRequest(input: CheckoutRequest): void {
  assertReference(input.publicQuoteReference, 'publicQuoteReference')
  const contact = record(input.bookingContact, 'bookingContact')
  text(at(contact, 'firstName'), 'bookingContact.firstName', 1, 100)
  text(at(contact, 'lastName'), 'bookingContact.lastName', 1, 100)
  const email = text(at(contact, 'email'), 'bookingContact.email', 3, 254)
  if (!/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email.trim())) fail('bookingContact.email', 'must be an e-mail address')
  const acceptance = record(input.acceptance, 'acceptance')
  text(at(acceptance, 'termsVersion'), 'acceptance.termsVersion', 1, 100)
  text(at(acceptance, 'cancellationPolicyVersion'), 'acceptance.cancellationPolicyVersion', 1, 100)
  text(at(acceptance, 'privacyNoticeVersion'), 'acceptance.privacyNoticeVersion', 1, 100)
  if (at(acceptance, 'accepted') !== true) fail('acceptance.accepted', 'must be true')
  if (input.language !== undefined && input.language !== 'de' && input.language !== 'en')
    fail('language', "must be 'de' or 'en'")
  if (input.returnUrl !== undefined) returnAddress(input.returnUrl)
  if (input.paymentUi !== undefined) {
    member(input.paymentUi, 'paymentUi', ['stripe_embedded_checkout', 'stripe_checkout_elements'] as const)
    if (input.paymentUi === 'stripe_checkout_elements' && input.returnUrl === undefined)
      fail('paymentUi', 'stripe_checkout_elements needs returnUrl')
  }
}

/** 0.12.0: a website's return address — https (loopback http), no credentials, no fragment, at most 1000 characters. */
function returnAddress(value: unknown): string {
  const address = text(value, 'returnUrl', 1, 1000)
  let url: URL
  try {
    url = new URL(address)
  } catch {
    return fail('returnUrl', 'must be an absolute https address')
  }
  if (
    address.includes('#') ||
    url.username ||
    url.password ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
  )
    fail('returnUrl', 'must be an absolute https address without credentials or fragment')
  return address
}
