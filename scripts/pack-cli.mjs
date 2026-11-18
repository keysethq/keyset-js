#!/usr/bin/env node
//
// Produce and verify a candidate @keyset/cli tarball. Never publishes; all output stays under the destination.
//
//   node scripts/pack-cli.mjs                 verify into a fresh temporary directory
//   node scripts/pack-cli.mjs <emptyDir>      verify into a directory you name
//   node scripts/pack-cli.mjs --quiet <dir>   same, without the tool chatter
//   node scripts/pack-cli.mjs --release       same, expecting the package to be public (the mirror's publish workflow)
//
// The CLI is a bin package, so what "verified" means differs from scripts/pack-sdk.mjs in one step:
//
//   1. the package builds and packs, and the tarball holds only compiled output plus the manifest, LICENSE, README
//      and CHANGELOG;
//   2. `publint` accepts the package metadata. `attw` is deliberately not run: the CLI exports no module and ships no
//      declarations, so there is no resolution for it to judge;
//   3. a consumer project OUTSIDE this repository installs the tarball, `keyset --help` and `keyset --version` run
//      from the installed bin, and a command that needs a login refuses cleanly instead of crashing;
//   4. hygiene: no runtime dependency, no workspace specifier, no test file, no source map, no internal work-item
//      identifier and no `@keyset/*` import survives into the published surface, and the manifest is still private.
//
// It prints the tarball's integrity hash, which is what names a candidate release.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2).filter((argument) => argument !== '--quiet' && argument !== '--release')
const quiet = process.argv.includes('--quiet')
// `--release` is what the mirror's publish workflow passes, after the owner removed `private`: the guard then flips
// from "must still be private" to "must not be private", so a candidate and a release are each checked for what they are.
const release = process.argv.includes('--release')
const stdio = quiet ? 'ignore' : 'inherit'
const destination = args[0] ? resolve(args[0]) : await mkdtemp(join(tmpdir(), 'keyset-cli-consumer-'))
if (destination === root || destination.startsWith(`${root}/`))
  throw new Error('Verify the packed CLI outside the repository, so the workspace cannot resolve it')
await mkdir(destination, { recursive: true })
if ((await readdir(destination)).length)
  throw new Error(
    'Use a fresh empty destination for each candidate; a reused path can serve a stale same-version cache',
  )

// What a published tarball carries besides compiled output.
const DOCUMENTS = ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md']

function run(command, commandArgs, cwd = root) {
  execFileSync(command, commandArgs, { cwd, stdio })
}
const failures = []
const expect = (condition, message) => {
  if (!condition) failures.push(message)
}

// 1. build and pack
run('bun', ['run', '--filter', '@keyset/cli', 'build'])
const vendor = join(destination, 'vendor')
await mkdir(vendor, { recursive: true })
run('bun', ['pm', 'pack', '--destination', vendor], join(root, 'packages/cli'))
const manifest = JSON.parse(await readFile(join(root, 'packages/cli/package.json'), 'utf8'))
const tarball = join(vendor, `keyset-cli-${manifest.version}.tgz`)
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
for (const required of ['dist/main.js', ...DOCUMENTS])
  expect(listed.includes(required), `the tarball is missing ${required}`)

// 2. package metadata. Through the root script rather than the binary path, so `bun run deadcode` sees the tool used.
run('bun', ['run', 'sdk:publint', tarball])

// 3. an independent consumer, outside the workspace
await writeFile(
  join(destination, 'package.json'),
  `${JSON.stringify(
    {
      name: 'keyset-cli-consumer',
      version: '0.0.0',
      private: true,
      type: 'module',
      dependencies: { '@keyset/cli': `file:./vendor/keyset-cli-${manifest.version}.tgz` },
    },
    null,
    2,
  )}\n`,
)
run('bun', ['install'], destination)
const bin = join(destination, 'node_modules/.bin/keyset')
// A clean environment: no stored login, no key, no deployment, so the run proves the package and not this machine.
const environment = { PATH: process.env.PATH ?? '', HOME: destination, XDG_CONFIG_HOME: join(destination, 'config') }
const invoke = (...commandArgs) =>
  spawnSync(bin, commandArgs, { cwd: destination, env: environment, encoding: 'utf8', timeout: 30_000 })

const help = invoke('--help')
expect(help.status === 0, `keyset --help exited ${help.status}: ${help.stderr}`)
for (const command of ['login', 'listen', 'trigger'])
  expect(help.stdout.includes(command), `keyset --help does not mention ${command}`)
const version = invoke('--version')
expect(
  version.status === 0 && version.stdout.trim().includes(manifest.version),
  `keyset --version printed "${version.stdout.trim()}", not ${manifest.version}`,
)
const signedOut = invoke('status')
expect(
  signedOut.status !== null && signedOut.status < 128,
  `keyset status crashed without a login: ${signedOut.stderr}`,
)

// 4. hygiene of the installed surface
const installed = JSON.parse(await readFile(join(destination, 'node_modules/@keyset/cli/package.json'), 'utf8'))
const installedText = JSON.stringify(installed)
expect(!installedText.includes('workspace:'), 'the installed manifest still carries a workspace specifier')
expect(
  release ? installed.private !== true : installed.private === true,
  release
    ? 'the packed manifest is still private, so npm would refuse to publish it'
    : 'the packed manifest is no longer private; publication is an owner decision',
)
expect(installed.license === 'MIT', 'the packed manifest does not say MIT')
expect(
  Object.keys(installed.dependencies ?? {}).length === 0,
  `the CLI gained runtime dependencies: ${Object.keys(installed.dependencies ?? {}).join(', ')}`,
)
for (const file of await readdir(join(destination, 'node_modules/@keyset/cli/dist'))) {
  if (!file.endsWith('.js')) continue
  const contents = await readFile(join(destination, 'node_modules/@keyset/cli/dist', file), 'utf8')
  expect(!/\bP[01]-[A-Z]{2,4}-\d/.test(contents), `${file} leaks an internal work-item identifier`)
  expect(!/^\s*(?:import|export)\b[^\n]*from ['"]@keyset\//m.test(contents), `${file} imports a workspace package`)
}

if (failures.length > 0) {
  process.stderr.write(`${failures.map((line) => `  - ${line}`).join('\n')}\n`)
  process.stderr.write(`${failures.length} packaging failure(s).\n`)
  process.exit(1)
}
process.stdout.write(
  `@keyset/cli ${manifest.version} verified from a standalone consumer.\n  tarball:   ${tarball}\n  integrity: ${integrity}\n  files:     ${listed.length}\n  consumer:  ${destination}\n`,
)
