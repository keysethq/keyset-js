# Changelog

All notable changes to `@keyset/sdk` are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the package follows [Semantic Versioning](https://semver.org/) from 1.0.0 (see [VERSIONING.md](./VERSIONING.md)).

## [1.0.0] - 2026-11-18

First public release. The API surface is the one 0.17.0 had, declared stable: from here on additive changes are minor
releases and a breaking change needs a major release after a stated deprecation period.

### Added

- MIT licence, `CHANGELOG.md` and `VERSIONING.md` in the package.
- A README that starts from `npm install @keyset/sdk`, with a first call that runs, the difference between test and
  live keys, and how to handle a `BookingResult`.
- An unknown problem code from the API is read as `UNRECOGNIZED_PROBLEM` with the server's code in `serverCode`, so a
  new problem code is never a breaking change for an installed SDK.
- An event whose type the SDK does not know is returned by `listEvents` as `type: 'unrecognized'` with the server's type
  in `serverType` (and `data` unparsed), so a new event type is never a breaking change for an installed SDK.
  `DeveloperEvent` is now a union of `KnownDeveloperEvent` and `UnrecognizedDeveloperEvent`; consumers with an
  exhaustive `switch` handle `'unrecognized'`.
- The problem codes `IDEMPOTENCY_IN_PROGRESS` (retryable) and `IDEMPOTENCY_OUTCOME_UNKNOWN` (not retryable: read the
  resource, never repeat the write).

### Changed

- `license` is `MIT` (it was `UNLICENSED` while the package was private).

## Before 1.0.0

The package was developed privately and distributed as a tarball; none of these versions were published. The history
below is summarised from the repository.

- **0.17**: a discount code the host gave a guest (`createQuote` takes `discountCode`; the quote and the property say
  whether one applies).
- **0.16**: a booking page that cannot take payments yet says so (`onlineBooking` is `false` on the property).
- **0.15**: what the same stay costs at every offered rate (`ratePlanTotals`).
- **0.14**: your own payment form from Stripe Checkout Elements (`paymentUi`).
- **0.13**: the checkout status tells a cancelled, no-show or refunded booking (`bookingState`, `cancelledAt`,
  `cancelledBy`, `refundedMinor`).
- **0.12**: price-line labels in the property's language and `discountKind`; one apartment's calendar; floor area; the
  guest's own page after booking; the return address after paying; 0.12.1 honours `retryable: false` in recovery advice.
- **0.11**: a guest who did not arrive is a booking state (`no_show`).
- **0.10**: a deposit at booking with the rest due later (`dueNow`, `remaining`).
- **0.8**: rate plans with their own cancellation terms; the guest chooses a rate in the booking step.
- **0.7**: tourist tax in the price or on site, with versioned rates.
- **0.6**: extras the guest adds while booking (per stay, per night, per person and night).
- **0.5**: discounts for longer stays, early booking and last minute; price lines may be negative.
- **0.4**: a browser can call Keyset directly with a publishable key (`pk_`) from listed origins; the host's own
  booking-page texts and English; units named by kind of business.
- **0.3**: `listEvents` for keys with `reservation.read`; granular booking permissions.
- **0.2**: money carries the property's ISO 4217 currency instead of a fixed EUR literal.
- **0.1**: the booking clients (browser, server, relay), the result model, idempotency keys, the secret-key client for
  Property reads, manual bookings and cancellation.
