# @keyset/sdk

The official TypeScript SDK for the Keyset direct-booking API. Search availability, take an authoritative price and
book a stay from your own accommodation website.

Zero runtime dependencies. Works in a browser and on a server, with the boundary in the import path.

```sh
npm install @keyset/sdk
```

Node 20 or newer on a server, any current browser in a page. Documentation, the API reference and guides:
[keyset.dev](https://keyset.dev). Changes between releases: [CHANGELOG.md](./CHANGELOG.md). What a version number
promises: [VERSIONING.md](./VERSIONING.md). Licence: MIT.

## Five-minute start

You need a Keyset test key and the ID of a Property in the test business (Einstellungen › Entwickler, API keys in the German app; the key
starts with `sk_test_ks1_`). Keep the key on your server; never put it in browser code. Save this as `start.mjs`:

```js
import { createKeyset } from '@keyset/sdk/server'

const keyset = createKeyset({
  secretKey: process.env.KEYSET_SECRET_KEY,
  apiBaseUrl: 'https://api.keyset.cloud',
})

const property = await keyset.getProperty(process.env.KEYSET_PROPERTY_ID)
if (!property.ok) {
  console.error(property.error)
  process.exit(1)
}
console.log(property.value.name, property.value.units.map((unit) => unit.name))
```

```sh
npm install @keyset/sdk
KEYSET_SECRET_KEY=sk_test_ks1_… KEYSET_PROPERTY_ID=… node start.mjs
```

It prints the Property's name and its units. A wrong key, a wrong Property or a missing grant comes back as
`property.error`, never as an exception. From here, take a booking on your own website with the relay and the browser
client below, or create a manual booking with the server client under "Server API keys".

## Test keys and live keys

A test key (`sk_test_ks1_…`, `pk_test_…`) works against a test business: a copy of your setup where payments are
simulated, no guest is written to and no mail leaves Keyset. A live key (`sk_live_ks1_…`, `pk_live_…`) works against
the real business. Both talk to `https://api.keyset.cloud`; the key decides which one you are on, and the SDK refuses
obvious mix-ups before sending anything. Develop with test keys, switch the key and nothing else when you go live.

## Handling a BookingResult

Every call returns `{ ok: true, value }` or `{ ok: false, error }` and never throws once the client exists. Branch on
`error.kind`: `invalid_request` (nothing was sent, fix the input), `outcome_unknown` (the answer was lost; repeat the
identical request with the identical idempotency key or read the state, never use a new key), `transport` (a read did
not complete, read again) and `api` (Keyset answered; `error.recovery` names the one safe next step and
`error.problem.code` is the stable code). The full pattern follows in "Errors are results, not exceptions".

## The five rules the API enforces

The API is small. What makes it safe is that it refuses to let a client guess, and the SDK exposes the distinctions a
consumer needs to handle them safely.

1. **Availability is advisory.** `searchAvailability` and `availabilityCalendar` read a moving world and reserve
   nothing. Only `startCheckout` competes for inventory.
2. **A quote is immutable and expires.** Show the quote total, never a preview total. A later rate change produces a
   new quote; it never alters an existing one.
3. **An idempotency key belongs to one intent.** Persist it before the first attempt, reuse it for every retry of
   that intent, and never reuse it for a different body.
4. **A redirect confirms nothing.** `checkoutStatus` is the only authority on whether a stay is booked.
5. **An unknown outcome is not a failure.** If a mutation's answer is lost, repeat the identical request with the
   identical key, or read the state. A fresh key is a new intent and can book twice.

## Which entrypoint

| Your code runs | Import from | It talks to |
|---|---|---|
| a browser | `@keyset/sdk/browser` | your own origin, through the relay you mount |
| your server | `@keyset/sdk/server` | the Keyset API directly |
| either | `@keyset/sdk` | nothing; types, the result model and `createIdempotencyKey` |

### Browser + relay (recommended for a guest-facing website)

Your page never talks to Keyset. Your server mounts the relay, and the guest's session and checkout capability live
in host-only `HttpOnly` cookies your page cannot read — so a cross-site script cannot lift them, and no API
credential ever reaches the browser.

```ts
// server.ts — mount unchanged at /public/*
import { createBookingRelay } from '@keyset/sdk/server'

const relay = createBookingRelay({
  websiteOrigin: 'https://example.com',
  apiOrigin: 'https://api-staging.keyset.cloud',
  propertyId: process.env.KEYSET_PROPERTY_ID!,
})
// in your framework: if (url.pathname.startsWith('/public/')) return relay(request)
```

```ts
// browser.ts
import { createBookingClient, createIdempotencyKey } from '@keyset/sdk/browser'

const booking = createBookingClient({
  websiteOrigin: window.location.origin,
  propertyId: 'public_property_...',
})

const offers = await booking.searchAvailability({
  checkIn: '2027-02-01',
  checkOut: '2027-02-03',
  occupancy: { adults: 2, children: 0 },
})
if (!offers.ok) return show(offers.error)

const key = createIdempotencyKey()
localStorage.setItem('booking-intent', key) // persist BEFORE dispatching
const quote = await booking.createQuote(
  { publicUnitReference: offers.value.offers[0]!.publicUnitReference, checkIn: '2027-02-01', checkOut: '2027-02-03', occupancy: { adults: 2, children: 0 } },
  { idempotencyKey: key },
)
```

### Server, without a browser

The server client holds the guest's capability itself, so it needs somewhere to keep it. One store per guest
session — never one shared store for every guest, or a caller who knows another guest's checkout reference could
read that checkout.

```ts
import { createBookingClient, createMemorySessionStore } from '@keyset/sdk/server'

const booking = createBookingClient({
  apiBaseUrl: 'https://api-staging.keyset.cloud',
  propertyId: 'public_property_...',
  session: createMemorySessionStore(), // example/test only; lost on restart and not shared between instances
})

const started = await booking.startCheckout({ publicQuoteReference, bookingContact, acceptance }, { idempotencyKey })
if (!started.ok) return handle(started.error)

const settled = await booking.waitForCheckout(started.value.publicCheckoutReference)
if (settled.ok && settled.value.reservationState === 'confirmed' && (settled.value.bookingState ?? 'confirmed') === 'confirmed') {
  console.log('booked', settled.value.confirmationReference)
}
```

### A date picker

`availabilityCalendar` answers, for each night of a window of up to 62 nights, whether an apartment that fits the
party is free, the lowest nightly price among those apartments and their shortest minimum stay. `fromPrice` is one
night including any weekend adjustment, before cleaning and service fees; a free night does not mean every stay
through it is free. It shares the search budget. Show it as a hint and take the price from a Quote.

```ts
const nights = await booking.availabilityCalendar({ from: '2027-02-01', nights: 31, occupancy: { adults: 2, children: 0 } })
if (nights.ok) for (const night of nights.value.nights) render(night.date, night.available, night.fromPrice)
```

## Errors are results, not exceptions

After a client is constructed, every request returns a `BookingResult<T>`. Factory misconfiguration still throws a
`TypeError`. The result union supports exhaustive handling, but TypeScript only checks every variant when the consumer
uses an exhaustive pattern such as `assertNever`.

```ts
const result = await booking.startCheckout(request, { idempotencyKey: key })
if (result.ok) return confirmed(result.value)

function assertNever(value: never): never {
  throw new Error(`Unhandled SDK variant: ${JSON.stringify(value)}`)
}

switch (result.error.kind) {
  case 'invalid_request':   return fix(result.error.path)          // never dispatched; nothing changed
  case 'outcome_unknown':   return retryWithTheSameKey(key)        // may have been applied; never a new key
  case 'transport':         return retryTheRead()                  // a read did not complete
  case 'api':
    switch (result.error.recovery) {
      case 'refresh_quote':      return newQuote()
      case 'search_again':       return newSearch()
      case 'correct_input':      return fixForm()
      case 'wait':               return poll()
      case 'retry_same_request': return retryWithTheSameKey(key)
      case 'retry_read':         return retryTheRead()
      case 'contact_support':    return support(result.error.requestId)
      default:                   return assertNever(result.error.recovery)
    }
  default:                       return assertNever(result.error)
}
```

`result.error.recovery` is the actionable part: it tells you what is safe to do, derived from the stable
`problem.code`. `problem.retryable` is the server's coarser hint; prefer `recovery`. Since 0.12.1 `recovery` also
honours it: a code without a fixed recovery that the server marks `retryable: false` gives `contact_support`, never
a retry.

### Error codes

| Code | HTTP | Recovery |
|---|---|---|
| `INVALID_BOOKING_DETAILS` | 413, 415, 422 | `correct_input` |
| `QUOTE_EXPIRED` | 409 | `refresh_quote` |
| `APARTMENT_NO_LONGER_AVAILABLE` | 409 | `search_again` |
| `IDEMPOTENCY_KEY_REUSED` | 409 | `contact_support` — a recovery conflict, not permission to start over |
| `PAYMENT_SESSION_UNAVAILABLE` | 409 | `wait`, then read the status |
| `BOOKING_NOT_AVAILABLE` | 404 | `contact_support` |
| `TOO_MANY_REQUESTS` | 429 | wait `problem.retryAfter` seconds |
| `SERVICE_UNAVAILABLE` | 503 | retry the identical request; `contact_support` when `retryable` is false (online booking unavailable, for example no payment account) |
| `INTERNAL_ERROR` | 500 | retry the identical request; `contact_support` when `retryable` is false |
| `CHECKOUT_EXPIRED` | — | `search_again`. Reserved: no operation emits it today. |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | `wait`, then repeat the identical request with the same key (server operations) |
| `IDEMPOTENCY_OUTCOME_UNKNOWN` | 409 | `retry_read`: read the resource to learn whether the write happened; never a new key (server operations) |
| `UNRECOGNIZED_PROBLEM` | any | a code newer than the installed SDK, in `problem.serverCode`; `recovery` follows `retryable` |

The server adds codes without a new contract version. An SDK that does not know one reads it as
`UNRECOGNIZED_PROBLEM` with its status and `retryable` intact, so a switch over `problem.code` needs a default branch.

## Wire formats

| Concept | Representation |
|---|---|
| Money | integer minor units as a decimal string, plus currency. Parse with `BigInt`, never `Number`. |
| Calendar day | `YYYY-MM-DD` in the property's timezone |
| Stay | half-open `[checkIn, checkOut)`; the departure day is not a booked night |
| Instant | RFC 3339 UTC, no offset suffix |
| Media | `property.presentation.images` and `unit.presentation.images`; stable relative URL, alt text, cover/gallery role, order, intrinsic dimensions and four fixed WebP variants |

Resolve an image URL against the same origin used by the client or relay. The medium URL is convenient for a single
image; `variants` supplies thumbnail, small, medium and large sources for `srcset`. Disk paths, storage keys and
upload metadata are never part of the SDK shape.

## Cancellation

Every call takes an `AbortSignal`. Cancelling a read yields a `transport` failure; cancelling a mutation yields
`outcome_unknown`, because an aborted request may still have been applied.

```ts
const controller = new AbortController()
const offers = await booking.searchAvailability(request, { signal: controller.signal })
```

## Reference

Full API reference, quickstart and concept guides: <https://keyset.dev>.

## Server API keys

Use `@keyset/sdk/server` for secret credentials. The browser and root entrypoints do not export `createKeyset`,
and the server factory also refuses browser execution. Never use a `NEXT_PUBLIC_` environment variable for a key.

Create a key under **Settings → Developers → API keys** in the operator SaaS. Choose **Property catalogue** for Property and
unit reads, or **Booking server** to read and create manual Reservations. **Booking overview** grants booking reads without creation. Cancellation is a separate, explicit choice. Names are prefilled and each resource/action
permission is visible and individually adjustable where optional. Keyset generates the secret when you create it;
you never supply your own token. The selected Properties are static: future
Properties are never included. Store the single revealed value in your server's secret manager.

```ts
import { createKeyset, type DeveloperReservationRequest } from '@keyset/sdk/server'
import { createIdempotencyKey } from '@keyset/sdk'

const secretKey = process.env.KEYSET_SECRET_KEY
if (!secretKey) throw new Error('Configure KEYSET_SECRET_KEY')
const keyset = createKeyset({
  secretKey,
  apiBaseUrl: 'https://api-staging.keyset.cloud',
})
const property = await keyset.getProperty(propertyId, { signal })
if (property.ok) {
  for (const unit of property.value.units) useUnit(unit)
}

// An offline agreement, not a payment collection or inferred price.
const booking: DeveloperReservationRequest = {
  unitId,
  checkIn: '2027-01-10',
  checkOut: '2027-01-12',
  occupancy: { adults: 2, children: 0 },
  contact: { firstName: 'Synthetic', lastName: 'Guest' },
  agreedTotalMinor: '20000',
  currency: 'EUR',
}
const idempotencyKey = createIdempotencyKey()
await saveIntent({ booking, idempotencyKey }) // your durable store, before sending
const result = await keyset.createReservation(propertyId, booking, { idempotencyKey, signal })
if (!result.ok) {
  if (result.error.kind === 'outcome_unknown') {
    // Keep the same body and key. Resolve this intent before starting another.
    await scheduleSameIntent({ booking, idempotencyKey })
  } else if (result.error.kind === 'api') {
    if (result.error.problem.code === 'PERMISSION_DENIED') {
      // Ask an authorized operator for reservation.create_manual on this Property.
    } else if (result.error.problem.status === 401) {
      // Check expiry/revocation and the configured test/live deployment.
    }
  }
}
```

`propertyId`, `unitId`, `signal`, `useUnit`, `saveIntent` and `scheduleSameIntent` are supplied by your application.
The SDK never generates a replacement idempotency key or automatically retries a mutation. A server error with
`retry_same_request` likewise requires the identical intent; it does not prove that nothing was committed.

Keys begin with `sk_test_ks1_` or `sk_live_ks1_`. Test means the isolated local/CI/staging database, or (0.4) a
business's test twin in production: a second business beside the real one, with a copy of its setup, where payments
are simulated and no guest is written to. Its keys are test keys in every deployment. Live means a real business in
production. The API verifies the credential record's environment against the deployment and, for a test key in
production, that it belongs to a test twin. The SDK also rejects known staging/live-origin mistakes early.

Choose **Replace key** to reveal a successor with the same principal and grants. Move your server to it within the
selected 1–24 hour overlap; the previous key expires at that cutoff and may be revoked immediately. Only one
successor can be created for a predecessor. If its reveal response is lost, reload the list and revoke that
inaccessible successor before creating another credential. Listing never recovers a plaintext key.

Revocation blocks new authentication. An already authenticated request may finish; do not revoke and assume that an
uncertain booking was cancelled. Permission and resource checks still run in the existing application commands.

The six anonymous booking operations still use the existing guest relay and checkout capability cookies. They do
not require publishable keys: the public Property identifier already supplies the public context. API credentials
cannot replace checkout capabilities or webhook signing secrets. Key management is absent from the external SDK.

### Granular booking permissions

| Permission | Supported operation |
|---|---|
| `property.read` | Property and apartment catalogue; required base scope |
| `reservation.read` | Read a known Reservation's identity, dates, unit and lifecycle; no contact data |
| `reservation.create_manual` | Create an offline Reservation with a durable idempotency key |
| `reservation.cancel` | Preview and commit cancellation, including policy-based asynchronous refunds for direct bookings |

Existing keys keep exactly their original permissions. Rotation preserves permissions too: create a separate
connection when you need a different scope. There is no generic write scope and no automatic future access.
A cancelling integration can hold `reservation.cancel` without general `reservation.read`; its preview exposes only
the version and financial decision necessary for that action. Imported bookings are not cancellable here.

```ts
const bookingState = await keyset.getReservation(propertyId, reservationId, { signal })
const preview = await keyset.previewCancellation(propertyId, reservationId, { signal })
if (preview.ok && preview.value.blocker === null) {
  const decision = {
    expectedVersion: preview.value.version,
    expectedRefundMinor: preview.value.refundMinor,
    reason: 'Guest requested cancellation',
  }
  // Persist and approve this exact decision before sending it.
  const cancelled = await keyset.cancelReservation(propertyId, reservationId, decision, { signal })
  if (!cancelled.ok && cancelled.error.kind === 'outcome_unknown') {
    // Read a fresh preview to determine the state, or repeat this identical decision.
    // Do not silently accept new refund terms after VERSION_CONFLICT or PREVIEW_STALE.
  }
  if (cancelled.ok) {
    // cancelled.value.refundState is separate from the cancellation itself.
    // 'requested', 'processing' and 'unknown' do not mean the refund succeeded.
    // Poll previewCancellation(...).value.refundState to observe the current refund state.
  }
}
```

Unlike creation, cancellation needs no idempotency header: the existing canonical command locks the Reservation,
creates its one immutable cancellation and returns that same record on replay. Version/refund comparison protects
the first transition; a repeated completed cancellation never creates another refund. The SDK never retries it
implicitly. `403` means a missing action permission within a readable Property; foreign/ungranted Properties and
unknown Reservations share `404`. Revoked/expired/wrong-environment credentials return `401`.

The new cancellation operations add `refresh_cancellation_preview` to the recovery union and four typed problem
codes (`VERSION_CONFLICT`, `PREVIEW_STALE`, `POLICY_MISSING`, `NOT_CANCELLABLE`). Consumers with exhaustive TypeScript
switches must handle these variants when upgrading from a pre-1.0 build (never published). Existing guest relay calls, authentication,
wire payloads and runtime recovery behavior are unchanged.

### Events (0.3)

A key with `reservation.read` reads what happened at a Property, oldest first — the same events a webhook delivers
(bookings confirmed, changed or cancelled, payments received, refunds succeeded or failed, blocks created or
released). Pass the id of the last event you have to continue; an event appears a few seconds after it happened and
stays thirty days. `data` carries references, stay, apartment and amounts, never guest contact data.

The server may add event types. One your SDK version does not know comes back with `type: 'unrecognized'` and the
server's type in `serverType`; its `data` is not parsed, so treat it as raw. Skip it or handle it by `serverType`.

```ts
let after: string | undefined
for (;;) {
  const page = await keyset.listEvents(propertyId, { ...(after ? { after } : {}), limit: 100 })
  if (!page.ok) break
  for (const event of page.value.events) {
    if (event.type === 'unrecognized') continue // a newer server's event: event.serverType, data unparsed
    handle(event)
  }
  after = page.value.events.at(-1)?.id ?? after
  if (!page.value.hasMore) break
}
```

0.3 also adds the price line kind `guest_surcharge` (a host's surcharge for further persons) and the optional
`childAges` of a party. A new response enumeration member is a breaking change for an installed client, hence the
minor version step of the pre-1.0 SDK, which was never published.

### Direct from the browser with a publishable key (0.4)

Without a server of your own, your page can call Keyset directly. In Keyset, under Einstellungen › API-Schlüssel ›
Öffentliche Schlüssel, create a publishable key and list your website's addresses (`https://www.example.com`, one per
line). Then:

```ts
import { createBookingClient } from '@keyset/sdk/browser'

const booking = createBookingClient({
  publishableKey: 'pk_test_…',
  apiOrigin: 'https://api-staging.keyset.cloud',
  propertyId: 'public_property_…',
})
```

The key is not a secret; it only names the business, and Keyset answers it only from the addresses you listed and only
for that business's booking pages. Everything else is the same client. The difference is where the guest's state
lives: the browser sends Keyset no cookies, so the guest's session and a started checkout's capability come back in
response headers and the SDK keeps them in this tab's session storage (`createBrowserSessionStore`; pass `session` to
keep them elsewhere). The capability reads that one checkout, like a payment provider's client secret: keep it in the
page, never in a URL or a log. Prefer the relay where you run a server — its cookies are `HttpOnly`, so a script on
your page cannot read them.

### Host texts and English (0.4)

`property()` now carries what the host wrote about the place: `presentation.location`, `presentation.amenities` and
`presentation.faq`, and each unit's `presentation.amenities`. Amenities are codes of Keyset's catalogue (`wifi`,
`parking` …) as plain strings; new codes may appear, so show the ones you know and skip the rest. `property({ language:
'en' })` answers the host's own texts in English where the host wrote them and in German where not; names, prices,
rules and legal texts are the same in every language.

### Discounts (0.5)

A host may give a discount on the accommodation — for a longer stay, for booking early or at the last minute. Only the
highest one that applies counts, and it arrives as one price line of kind `discount` with a **negative** amount, after
the nights and before the cleaning fee; the lines still sum to the total. Show its `label`, or your own words for it.
Totals never become negative. A client before 0.5 refuses a quote that carries a discount, which is why this is a minor
version of its own.

### Extras (0.6)

A unit may offer extras — breakfast, a pet, a late check-out — in `property().units[].extras`, each with `amount` once
per stay, per night, or per person and night. Pass the ids the guest chose as `extras` to `createQuote`; each becomes a
price line of kind `extra` named by the host. A client before 0.6 refuses a quote that carries one.

### Tourist tax (0.7)

When the host charges a tourist tax with the booking, the quote carries it as one price line of kind `tourist_tax`
after the fees; the lines still sum to the total. When the host collects it on arrival instead, it is not in `total`
or `dueNow` and the quote lists it in `payableOnSite` — show it next to the total as due on site. A client before 0.7
refuses a quote that carries the line.

### Rate plans (0.8)

A host may offer rates besides the standard one, listed in `property().ratePlans`: each a discount on the
accommodation (nights, weekend and season prices, extra guests — never cleaning, extras or tourist tax) with its own
cancellation terms, offered for every unit except those in `excludedUnits`. Pass the chosen `ratePlan` to
`createQuote`; the quote names it in `ratePlan`, its discount is a `discount` line named after it, and
`cancellation` states the terms it binds. `freeCancellationDays: null` means the rate never allows free cancellation:
show no free day then. Without `ratePlan` a stay is quoted at the standard rate, as before. A withdrawn rate answers
`BOOKING_NOT_AVAILABLE`; read the property again.

Since 0.9, `checkoutStatus` also names the rate in `ratePlan` and states the terms the booking binds in
`cancellation`, so a confirmation page shows the chosen rate's terms rather than the property's. Both are absent from
servers before 0.9 and for a booking whose host published no terms; `ratePlan` is absent for the standard rate.

Since 0.15 a quote for a unit offered at more than the standard rate carries `ratePlanTotals`: what the same stay
(unit, dates, party, extras) costs at each rate, the standard rate first with `ratePlan: null`, then the host's order.
Show these beside the choices instead of percentages. The chosen rate's entry equals the quote's `total`; every other
is what a quote with that rate would carry if made now, so choosing it still means `createQuote` with its `ratePlan`.
Nothing is held at those amounts, and they are never computed in the browser. Absent from servers before 0.15 and when
only the standard rate is offered.

### Tiered cancellation terms (1.1)

A host may stage the refund by hours before arrival. Then `property().legal.cancellation`, a quote's `cancellation`
and `checkoutStatus().cancellation` also carry `refundTiers` (first tier first; `hoursBeforeArrival`,
`refundBasisPoints`, and on a quote or booking `until`, the property-local deadline `YYYY-MM-DDTHH:MM`, inclusive)
and `arrivalTime` (`HH:MM`). The first tier whose deadline has not passed applies; after the last one
`lateRefundBasisPoints` does. When `refundTiers` is present it is the terms, and `freeCancellationDays` is only a
cautious summary for older readers. For a day rule these fields are absent and nothing changes.

### Deposits (0.10)

A host may take a deposit. Then a quote's `dueNow` is the deposit, not the `total`, and `balance` names the rest and
the property-local day `dueOn` it is charged from the card the guest pays the deposit with; if that charge fails, the
guest is asked by e-mail to pay it. Show both before the guest pays. `checkoutStatus` repeats them as `deposit` and
`balance` once booked. Without a deposit both are absent and `dueNow` equals `total`, as before.

### No-shows (0.11)

A booking whose guest never came can be marked by the host. A developer booking's `state` is then `no_show`: the
apartment is free again and nothing was refunded. An SDK before 0.11 refuses that state as unknown, as it refuses every
state it does not understand; update before reading bookings of a host who marks no-shows.

### Back to your website after paying (0.12)

When your own website starts the checkout, send `returnUrl` with `startCheckout`, for example
`https://www.example.com/buchen`. Card payments complete inside your page; a payment that has to leave it brings the
guest back to that address with `keyset_checkout=<publicCheckoutReference>`, so your page reads `checkoutStatus` for
it again (the relay's cookie or the tab's session still holds the capability). The address must be `https` and its
origin listed on one of the business's active publishable keys (Einstellungen › Entwickler › Eigene Website) — with
the relay too, where no key is sent. Otherwise the checkout is refused with `INVALID_BOOKING_DETAILS` and nothing is
held. Repeating the request under the same idempotency key keeps the address first recorded. Without `returnUrl` the
guest returns to Keyset's own booking page, as before. 0.12 also sends the request's `language`, which earlier
versions dropped.

### Your own payment form (0.14)

By default `paymentSession` hands over Stripe's embedded Checkout page, a complete form in an iframe. To build the
form in your site's own design instead, send `paymentUi: 'stripe_checkout_elements'` with `startCheckout`, together
with `returnUrl` (without it the SDK refuses the request before sending it). `checkoutStatus` then answers
`paymentUi.kind: 'stripe_checkout_elements'`, and `paymentSession` the same `kind` with the same four fields:

```ts
const stripe = await loadStripe(session.publishableKey, { stripeAccount: session.accountId })
const checkout = stripe.initCheckoutElementsSdk({
  clientSecret: session.clientSecret,
  elementsOptions: { appearance: { variables: { colorPrimary: '#6b7a5a', fontFamily: 'Karla' } } },
})
checkout.createPaymentElement().mount('#payment')
const loaded = await checkout.loadActions()
// on submit, with your own button:
const result = loaded.type === 'success' ? await loaded.actions.confirm({ redirect: 'if_required' }) : null
```

Card payments complete in your page; a payment that has to leave it returns to `returnUrl` as above. The amount,
currency, expiry, payment methods and webhooks are the same as with the embedded page, and a successful `confirm` still
confirms nothing: keep reading `checkoutStatus`. When the host takes a deposit, Stripe's Payment Element itself states
that the card is kept for the rest. The choice is recorded with the checkout; a repeat under the same idempotency key
with another `paymentUi` is `IDEMPOTENCY_KEY_REUSED`. An SDK before 0.14 never sees the new kind, because Keyset
answers it only to a checkout that asked for it.

### A discount code from the host (0.17)

A host can give regular guests a discount code. `property().discountCodes` is `true` while the host has one on offer;
show a field for it then, and only then. Pass it as typed in `createQuote({ ..., discountCode })`; case and
spaces do not matter. Its discount takes part in the stay's one discount — the highest of the host's discounts counts —
and shows as a `discount` line with `discountKind: 'discount_code'`, labelled with the code. `quote.discountCode` says
which code the quote carries and whether it is the discount that counted (`applied`). A code that does not count is
refused with `INVALID_BOOKING_DETAILS` and `problem.discountCode === 'not_valid'` — the same answer whether the code
never existed, was ended or is not valid today. Quotes with a code count against a separate hourly budget per visitor,
so offer the field once, not on every keystroke. You never send an amount.

### A page that cannot take bookings yet (0.16)

`property().onlineBooking` is `false` while the host has not finished setting up payments. Availability, prices and
quotes read as usual, but `startCheckout` answers `SERVICE_UNAVAILABLE` and nothing is held. Show the stay and the
host's contact from `property().host` instead of asking for the guest's name and e-mail. The field is absent when the
property takes bookings online, and from an API before it.

### Bookable from a date (1.2)

A host can keep the property visible but closed to new bookings, for example before it opens. `property().bookingStatus`
is `{ state: 'open' }`, or `{ state: 'closed', opensOn }` with `opensOn` the local date (`YYYY-MM-DD` in
`property().timezone`) from which it takes bookings by itself, or `null` while the host has named none. Units, prices and
availability read as usual; `onlineBooking` is `false`. Decide yourself what the page shows:

```ts
const status = property.bookingStatus ?? { state: 'open' }
if (status.state === 'closed') {
  const from = status.opensOn
    ? new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
        new Date(`${status.opensOn}T00:00:00Z`),
      )
    : null
  showNotice(from ? `Buchbar ab ${from}` : 'Noch nicht buchbar') // and hide the booking form or link the host
}
```

A client that ignores the status is refused all the same: `createQuote` and `startCheckout` answer
`BOOKING_NOT_AVAILABLE` (status 409) with the same `bookingStatus` on the problem.

### One apartment, its size and the guest's own page (0.12)

`availabilityCalendar({ …, publicUnitReference })` answers every night for that one apartment instead of the whole
property, for a calendar beside one apartment. An apartment the booking page does not offer is `not_found`, exactly
like an unknown property. The relay passes the reference on as a fifth query parameter and nothing else.

`property()` carries an apartment's `presentation.floorArea` in whole square metres when the host gave one.

Once a booking is confirmed, `checkoutStatus` carries `guestPortalUrl`: the guest's own page for it (stay, payment,
cancelling under the booking's terms, writing to the host), for a link on your confirmation page. It reaches only a
reader of that checkout, because Keyset derives it from the checkout's capability, and it is offered for one day after
confirmation; later it is `null` and the guest's e-mails carry it. It is a bearer link: show it to the guest, and never
put it into a URL, log or analytics event of your own. The client asks for it with `include=guestPortalUrl`, the one query the
relay passes on for a checkout status; a reader that does not ask gets no link, and none is created.

### Price lines in the property's language (0.12)

Keyset writes its own price-line labels in the property's language: „Übernachtung“, „Endreinigung“, „Kurtaxe“,
„Frühbucherrabatt“ for a German property, the English words for any other. A percentage fee, an extra and a rate plan
keep the host's own words. A `discount` line also says which discount it is in `discountKind` (`length_of_stay`,
`early_booking`, `last_minute`, `rate_plan`), so a site that speaks another language than the property translates by
`kind` and `discountKind` instead of matching the label's text. A label is fixed when the quote is made; a quote made
before this keeps its English label, and `discountKind` is set on it too.

### After the booking: cancelled, no-show, refunded (0.13)

`checkoutStatus` stays the authority after the stay is booked, so a confirmation page read again a day later shows
what is true now. `reservationState` stays `confirmed` once the checkout made a booking; `bookingState` says whether it
still stands: `confirmed`, `cancelled` (by the guest in the guest portal or by the host; `cancelledAt` and
`cancelledBy` say when and who) or `no_show`. Once it is not `confirmed`, `safeNextAction` is `none` instead of
`booking_confirmed`. `refund` is the money returned to the guest across all the booking's payments — `amount`, the part
the provider has confirmed as `refunded`, and `state` `pending`, `succeeded` or `failed` (then the host has been told;
ask the guest to contact the host) — or `null` when nothing was refunded. A change by the host keeps showing in
`changedAt` with the new stay and total. Never show a booking as confirmed on `reservationState` alone: check
`bookingState` too (absent only from a server that predates it). An SDK before 0.13 ignores these fields, so it keeps
reading such a booking as confirmed.

### Server client configuration and recovery

`createKeyset` validates the secret format, HTTPS origin, known test/live host pairing and `timeoutMs` when the
client is constructed. A timeout must be an integer from 0 to 2147483647 milliseconds (default 15000); invalid
configuration throws `TypeError` immediately. Request methods keep their explicit result semantics.

The operator API-key page provides a copyable, Property-specific server example using `KEYSET_SECRET_KEY`. The
example never contains the credential itself. Store the one-time secret in your server secret manager/environment,
then use the separately copied example. Existing keys and their expiry/last-use status remain visible without
opening the creation form; access and historical metadata are available under each key.

## 0.2 currency compatibility

Money responses carry the property’s ISO 4217 currency instead of the former EUR-only literal. Preserve
that currency together with integer minor units, including zero- and three-digit currencies; do not divide
every amount by 100 or assume euros. Existing EUR amounts and routes retain their meaning.

## Versions and stability

`@keyset/sdk` follows semantic versioning from 1.0.0. A new method, an optional field or a new error code is a minor
release; a breaking change comes only in a major release, after a stated deprecation period. Adding a member to a
response enumeration counts as breaking, because code that handles every member exhaustively would stop compiling.
The API itself announces deprecations with `Deprecation` and `Sunset` response headers. The full rule is in
[VERSIONING.md](./VERSIONING.md) and on [keyset.dev](https://keyset.dev/stability/).

## Support

Issues are welcome at the public repository (`keysethq/keyset-js`). The source of truth for the SDK is Keyset's private
repository; the public one is a mirror that releases are built from. Security reports: see `SECURITY.md` there.
