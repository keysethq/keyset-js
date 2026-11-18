# Versioning and stability

`@keyset/sdk` and the Keyset API follow one rule, so you can upgrade without reading the code.

## The package

- **Semantic Versioning from 1.0.0.** `MAJOR.MINOR.PATCH`.
- **Patch**: a fix that changes no type and no documented behaviour.
- **Minor**: anything additive. A new method, an optional field or option, a new error code, a new event type, a new
  entry point. Code that compiled against 1.x keeps compiling and behaving against 1.y for y greater than x.
- **Major**: anything breaking. A removed or renamed export, a tightened type, a changed behaviour, and **a new member in
  a response enumeration**. The SDK validates responses strictly on required fields and enumerations and ignores
  unknown keys, so an installed version survives an additive API change but never acts on a state it does not
  understand. Because exhaustive handling (`assertNever`) stops compiling when an enumeration grows, adding a member is
  a major change for the SDK. Keyset therefore adds states to enumerations only together with a new major version, or
  behind an option you set yourself.
- **Deprecation period.** A feature is marked `@deprecated` in a minor release, stays working for at least twelve months
  and is removed only in the next major release. The changelog names the replacement.
- **Node.** The supported Node.js versions are the active and maintenance LTS lines; dropping one is a major change.

`@keyset/cli` is versioned 0.x. Until it reaches 1.0.0 a minor release may change a command or its output; the
changelog says so every time.

## The API

- The API has one published contract, `GET https://api.keyset.cloud/public/openapi.json`. A change to it is classified
  before it ships: additive (a new operation, an optional field, a new problem code) or breaking.
- A breaking change never replaces a working version in place. It arrives as a new version beside the old one, and the
  old one is announced as deprecated for at least twelve months.
- **Deprecation is announced in the response.** A response from a deprecated operation, field or version carries a
  `Deprecation` header (RFC 9745) and, once the end date is fixed, a `Sunset` header (RFC 8594) with that date, and a
  `Link` header with `rel="deprecation"` pointing at the migration notes on [keyset.dev](https://keyset.dev/stability/).
  Treat the first `Deprecation` header you see as a reason to read the changelog.
- Security fixes and legal obligations can shorten a period; Keyset says so in the changelog when it does.

## What is not covered

Documented behaviour is stable; undocumented behaviour is not. Do not depend on header order, the exact wording of
`title` and `detail` in a problem response (use `code`), the opaque form of a cursor or an ID, or anything under
`/embed/v1/` other than the documented element.
