#!/usr/bin/env node
//
// Produce and verify a candidate @keyset/sdk tarball. Never publishes; all output stays under the destination.
//
//   node scripts/pack-sdk.mjs                 verify into a fresh temporary directory
//   node scripts/pack-sdk.mjs <emptyDir>      verify into a directory you name
//   node scripts/pack-sdk.mjs --quiet <dir>   same, without the tool chatter
//   node scripts/pack-sdk.mjs --release       same (accepted for the mirror's publish workflow)
//
// What "verified" means here, in order:
//
//   1. the package builds and packs, and the tarball holds only compiled output plus the manifest, LICENSE, README,
//      CHANGELOG and VERSIONING;
//   2. `publint` accepts the package metadata, and `attw --profile esm-only` accepts the declarations. The profile is
//      deliberate: this package is ESM-only, so the node10 and require() resolutions are expected to fail and are
//      ignored rather than papered over with a bundled CommonJS copy;
//   3. a consumer project OUTSIDE this repository installs the tarball and compiles against it under the same strict
//      settings Keyset uses, with `skipLibCheck: false`, so a defect in the shipped declarations fails here;
//   4. the compiled consumer actually runs all three entrypoints against a stub transport;
//   5. hygiene: no workspace specifier, no `./src/` export, no test file, no source map, no internal work-item
//      identifier and no `@keyset/*` import survives into the published surface, and the browser bundle contains no
//      server-only symbol.
//
// It prints the tarball's integrity hash, which is what names a candidate release.
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2).filter((argument) => argument !== '--quiet' && argument !== '--release')
const quiet = process.argv.includes('--quiet')
// `--release` is still accepted (the mirror's publish workflow passes it). Since the owner released the package on
// 18 Nov 2026, every check, candidate or release, requires the packed manifest to be publishable.
const stdio = quiet ? 'ignore' : 'inherit'
const destination = args[0] ? resolve(args[0]) : await mkdtemp(join(tmpdir(), 'keyset-sdk-consumer-'))
if (destination === root || destination.startsWith(`${root}/`))
  throw new Error('Verify the packed SDK outside the repository, so the workspace cannot resolve it')
await mkdir(destination, { recursive: true })
if ((await readdir(destination)).length)
  throw new Error(
    'Use a fresh empty destination for each candidate; a reused path can serve a stale same-version cache',
  )

function run(command, commandArgs, cwd = root) {
  execFileSync(command, commandArgs, { cwd, stdio })
}
const failures = []
// What a published tarball carries besides compiled output: the manifest, the licence and the documents a stranger reads.
const DOCUMENTS = ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md', 'VERSIONING.md']
const expect = (condition, message) => {
  if (!condition) failures.push(message)
}

// 1. build and pack
run('bun', ['run', '--filter', '@keyset/sdk', 'build'])
const vendor = join(destination, 'vendor')
await mkdir(vendor, { recursive: true })
run('bun', ['pm', 'pack', '--destination', vendor], join(root, 'packages/sdk'))
const manifest = JSON.parse(await readFile(join(root, 'packages/sdk/package.json'), 'utf8'))
const tarball = join(vendor, `keyset-sdk-${manifest.version}.tgz`)
const integrity = `sha512-${createHash('sha512')
  .update(await readFile(tarball))
  .digest('base64')}`

const listed = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
  .trim()
  .split('\n')
  .map((entry) => entry.replace(/^package\//, ''))
  .toSorted()
expect(
  listed.every((entry) => entry.startsWith('dist/') || DOCUMENTS.includes(entry)),
  `the tarball ships something other than dist and ${DOCUMENTS.join(', ')}: ${listed.join(' ')}`,
)
expect(!listed.some((entry) => entry.includes('.test.')), 'the tarball ships test files')
expect(!listed.some((entry) => entry.endsWith('.map')), 'the tarball ships source maps')
for (const required of ['dist/index.js', 'dist/index.d.ts', 'dist/browser.d.ts', 'dist/server.d.ts', ...DOCUMENTS])
  expect(listed.includes(required), `the tarball is missing ${required}`)

// 2. package-quality tools
// Through the root scripts rather than the binary path, so `bun run deadcode` can see that both tools are used.
run('bun', ['run', 'sdk:publint', tarball])
run('bun', ['run', 'sdk:attw', tarball])

// 3. an independent consumer, outside the workspace
await writeFile(
  join(destination, 'package.json'),
  `${JSON.stringify(
    {
      name: 'keyset-sdk-consumer',
      version: '0.0.0',
      private: true,
      type: 'module',
      scripts: { build: 'tsc -p tsconfig.json' },
      dependencies: { '@keyset/sdk': `file:./vendor/keyset-sdk-${manifest.version}.tgz` },
      devDependencies: { typescript: '7.0.2', '@types/node': '24.10.1' },
    },
    null,
    2,
  )}\n`,
)
await writeFile(
  join(destination, 'tsconfig.json'),
  `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2024',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        lib: ['ES2024', 'DOM'],
        types: ['node'],
        strict: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        verbatimModuleSyntax: true,
        skipLibCheck: false,
        outDir: 'dist',
      },
      include: ['consumer.ts'],
    },
    null,
    2,
  )}\n`,
)
await writeFile(
  join(destination, 'consumer.ts'),
  `import { createIdempotencyKey, describeFailure, isUnknownOutcome } from '@keyset/sdk'
import type { Availability, BookingFailure, BookingProblem, BookingRecovery, BookingResult, CheckoutStatus, Money, SafeNextAction } from '@keyset/sdk'
import { createBookingClient as createBrowserClient } from '@keyset/sdk/browser'
import { createBookingClient as createServerClient, createBookingRelay, createMemorySessionStore } from '@keyset/sdk/server'
import type { BookingSessionStore } from '@keyset/sdk/server'

const propertyId = 'public_property_consumer_check_1'
const money: Money = { minorUnits: '24500', currency: 'EUR' }
const action: SafeNextAction = 'wait'
const store: BookingSessionStore = createMemorySessionStore()

function assertNever(value: never): never {
  throw new Error(\`Unhandled SDK variant: \${JSON.stringify(value)}\`)
}
function exhaustiveRecovery(recovery: BookingRecovery): string {
  switch (recovery) {
    case 'refresh_quote': return 'refresh_quote'
    case 'refresh_cancellation_preview': return 'refresh_cancellation_preview'
    case 'search_again': return 'search_again'
    case 'correct_input': return 'correct_input'
    case 'wait': return 'wait'
    case 'retry_same_request': return 'retry_same_request'
    case 'retry_read': return 'retry_read'
    case 'contact_support': return 'contact_support'
    default: return assertNever(recovery)
  }
}
function exhaustiveFailure(failure: BookingFailure): string {
  switch (failure.kind) {
    case 'invalid_request': return failure.message
    case 'outcome_unknown': return failure.message
    case 'transport': return failure.message
    case 'api': return exhaustiveRecovery(failure.recovery)
    default: return assertNever(failure)
  }
}

const property = {
  publicPropertyId: propertyId,
  displayName: 'Consumer Check',
  locale: 'de-DE',
  timezone: 'Europe/Berlin',
  currency: 'EUR',
  units: [{ publicUnitReference: 'public_unit_consumer_check_0001', displayName: 'Apartment 1', maxOccupancy: 4 }],
  addedLater: true,
}
const stub: typeof globalThis.fetch = async (input) =>
  String(input).includes('/search')
    ? Response.json({ asOf: '2027-01-01T00:00:00.000Z', inventoryGuarantee: 'none', offers: [] })
    : Response.json(property)

async function main(): Promise<void> {
  const browser = createBrowserClient({ websiteOrigin: 'https://example.com', propertyId, fetch: stub })
  const read: BookingResult<Awaited<ReturnType<typeof browser.property>>['ok'] extends true ? never : never> | undefined = undefined
  void read
  const first = await browser.property()
  if (!first.ok) throw new Error(describeFailure(first.error))
  if (first.value.displayName !== 'Consumer Check') throw new Error('unexpected property')
  if (Object.hasOwn(first.value, 'addedLater')) throw new Error('an additive API field leaked into the parsed value')

  const availability: BookingResult<Availability> = await browser.searchAvailability({
    checkIn: '2027-02-01',
    checkOut: '2027-02-03',
    occupancy: { adults: 2, children: 0 },
  })
  if (!availability.ok) throw new Error(describeFailure(availability.error))

  const invalid = await browser.searchAvailability({ checkIn: '2027-02-03', checkOut: '2027-02-01', occupancy: { adults: 1, children: 0 } })
  if (invalid.ok || invalid.error.kind !== 'invalid_request') throw new Error('an impossible stay was dispatched')

  const server = createServerClient({ apiBaseUrl: 'https://api.example', propertyId, session: store, fetch: stub })
  const serverRead = await server.property()
  if (!serverRead.ok) throw new Error('the server client could not read the property')

  const lost = await createServerClient({
    apiBaseUrl: 'https://api.example',
    propertyId,
    session: createMemorySessionStore(),
    fetch: async () => {
      throw new Error('connection lost')
    },
  }).createQuote(
    { publicUnitReference: 'public_unit_consumer_check_0001', checkIn: '2027-02-01', checkOut: '2027-02-03', occupancy: { adults: 2, children: 0 } },
    { idempotencyKey: createIdempotencyKey() },
  )
  if (!isUnknownOutcome(lost)) throw new Error('a lost mutation answer was not reported as an unknown outcome')

  const relay = createBookingRelay({ websiteOrigin: 'https://example.com', apiOrigin: 'https://api.example', propertyId, fetch: stub })
  const refused = await relay(new Request('https://example.com/public/booking-properties/other'))
  if (refused.status !== 404) throw new Error('the relay did not refuse a foreign property')

  const problem: BookingProblem = { type: 'about:blank', title: 'x', status: 429, code: 'TOO_MANY_REQUESTS', retryable: true }
  const status: CheckoutStatus | undefined = undefined
  void problem
  void status
  void action
  void money
  void exhaustiveFailure
  process.stdout.write('consumer ok\\n')
}
await main()
`,
)
run('bun', ['install'], destination)
run('bun', ['run', 'build'], destination)
// 4. it runs
const output = execFileSync(process.execPath, ['dist/consumer.js'], { cwd: destination, encoding: 'utf8' })
expect(output.includes('consumer ok'), `the consumer did not run cleanly: ${output}`)

// 5. hygiene of the installed surface
const installed = JSON.parse(await readFile(join(destination, 'node_modules/@keyset/sdk/package.json'), 'utf8'))
const installedText = JSON.stringify(installed)
expect(!installedText.includes('workspace:'), 'the installed manifest still carries a workspace specifier')
expect(!installedText.includes('./src/'), 'the installed manifest still points at source')
expect(installed.private !== true, 'the packed manifest is still private, so npm would refuse to publish it')
expect(
  Object.keys(installed.dependencies ?? {}).length === 0,
  `the SDK gained runtime dependencies: ${Object.keys(installed.dependencies ?? {}).join(', ')}`,
)
const declarations = await readdir(join(destination, 'node_modules/@keyset/sdk/dist'))
for (const file of declarations) {
  const contents = await readFile(join(destination, 'node_modules/@keyset/sdk/dist', file), 'utf8')
  expect(!/\bP[01]-[A-Z]{2,4}-\d/.test(contents), `${file} leaks an internal work-item identifier`)
  // Only a real import statement counts. The package documents its own entrypoints in JSDoc, and those examples
  // survive into the declarations on purpose, so `@keyset/sdk/...` inside a comment must not be a failure.
  expect(
    !/^\s*(?:import|export)\b[^\n]*from ['"]@keyset\/(?!sdk['"/])/m.test(contents),
    `${file} imports another workspace package`,
  )
}
// The browser build must not be able to contain the relay, a secret name or a Node import.
await mkdir(join(destination, 'public'), { recursive: true })
await writeFile(
  join(destination, 'browser-entry.ts'),
  `import { createBookingClient } from '@keyset/sdk/browser'\nexport const client = createBookingClient({ websiteOrigin: 'https://example.com', propertyId: 'public_property_consumer_check_1' })\n`,
)
run('bun', ['build', 'browser-entry.ts', '--target', 'browser', '--outdir', 'public'], destination)
const bundle = await readFile(join(destination, 'public/browser-entry.js'), 'utf8')
for (const forbidden of [
  'createBookingRelay',
  'createMemorySessionStore',
  'createKeyset',
  'secretKey',
  'node:',
  'keyset_public_session',
])
  expect(!bundle.includes(forbidden), `the browser bundle contains ${forbidden}`)

// A mistaken browser import must fail at package resolution, before any credential can be sent.
await writeFile(
  join(destination, 'secret-browser-entry.ts'),
  "import { createKeyset } from '@keyset/sdk/server'\nexport const client = createKeyset({ secretKey: 'invalid', apiBaseUrl: 'https://api-staging.keyset.cloud' })\n",
)
let refusedServerImport = false
try {
  execFileSync('bun', ['build', 'secret-browser-entry.ts', '--target', 'browser', '--outdir', 'refused-browser'], {
    cwd: destination,
    stdio: 'pipe',
  })
} catch {
  refusedServerImport = true
}
expect(refusedServerImport, 'a browser bundle resolved the secret server entrypoint')

if (failures.length > 0) {
  process.stderr.write(`${failures.map((line) => `  - ${line}`).join('\n')}\n`)
  process.stderr.write(`${failures.length} packaging failure(s).\n`)
  process.exit(1)
}
process.stdout.write(
  `@keyset/sdk ${manifest.version} verified from a standalone consumer.\n  tarball:   ${tarball}\n  integrity: ${integrity}\n  files:     ${listed.length}\n  bundle:    ${bundle.length} bytes unminified\n  consumer:  ${destination}\n`,
)
