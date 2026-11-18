import { randomBytes } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { WEBHOOK_SECRET } from './signature.js'
import { apiOrigin } from './urls.js'

/** What `keyset login` keeps: the key, the Property it reads and the local signing secret for `listen`. */
export interface StoredConfig {
  readonly apiBaseUrl: string
  readonly propertyId: string
  readonly propertyName: string
  readonly secretKey: string
  /** The Property is a test twin (Testbetrieb). */
  readonly test: boolean
  readonly webhookSecret: string
  /** Set only for KEYSET_WEBHOOK_SECRET: the person already has it, and a CI log must not show it. Never stored. */
  readonly webhookSecretFromEnvironment?: true
}

/** The signing secret as `listen` and `resend` print it: in full when the CLI made it, else named only. */
export function shownWebhookSecret(config: StoredConfig): string {
  return config.webhookSecretFromEnvironment ? 'the one in KEYSET_WEBHOOK_SECRET' : config.webhookSecret
}

export const SECRET_KEY = /^sk_(test|live)_ks1_([a-f0-9]{32})_[A-Za-z0-9_-]{43}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isLiveKey(secretKey: string): boolean {
  return secretKey.startsWith('sk_live_')
}

/** `sk_test_ks1_<lookup>...`: enough to recognise the key in Einstellungen › Entwickler, nothing that opens it. */
export function maskKey(secretKey: string): string {
  const match = SECRET_KEY.exec(secretKey)
  return match ? `sk_${match[1]}_ks1_${match[2]}...` : 'sk_...'
}

/** `${XDG_CONFIG_HOME:-~/.config}/keyset/config.json`; a relative XDG_CONFIG_HOME is ignored, as the spec says. */
export function configPath(env: Readonly<Record<string, string | undefined>>, home: string): string {
  const base = env['XDG_CONFIG_HOME']
  return join(base && isAbsolute(base) ? base : join(home, '.config'), 'keyset', 'config.json')
}

function parseConfig(value: unknown): StoredConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = Object.fromEntries(Object.entries(value))
  const { apiBaseUrl, propertyId, propertyName, secretKey, test, webhookSecret } = entries
  if (typeof apiBaseUrl !== 'string' || apiOrigin(apiBaseUrl) !== apiBaseUrl) return null
  if (typeof propertyId !== 'string' || !UUID.test(propertyId)) return null
  if (typeof propertyName !== 'string') return null
  if (typeof secretKey !== 'string' || !SECRET_KEY.test(secretKey)) return null
  if (typeof test !== 'boolean') return null
  if (typeof webhookSecret !== 'string' || !WEBHOOK_SECRET.test(webhookSecret)) return null
  return { apiBaseUrl, propertyId, propertyName, secretKey, test, webhookSecret }
}

export type LoadedConfig =
  | { readonly state: 'present'; readonly config: StoredConfig }
  | { readonly state: 'missing' }
  | { readonly state: 'unreadable' }

export async function loadConfig(path: string): Promise<LoadedConfig> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { state: 'missing' }
    return { state: 'unreadable' }
  }
  try {
    const config = parseConfig(JSON.parse(text))
    return config ? { state: 'present', config } : { state: 'unreadable' }
  } catch {
    return { state: 'unreadable' }
  }
}

/**
 * Writes the file atomically: a fresh 0600 file beside it, flushed, then renamed over the old one, so a crash leaves
 * either the old or the new config and never a half-written key. The directory is 0700.
 */
export async function saveConfig(path: string, config: StoredConfig): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, 'utf8')
    await handle.chmod(0o600)
    await handle.sync()
  } catch (error) {
    await handle.close()
    await rm(temporary, { force: true })
    throw error
  }
  await handle.close()
  try {
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/** True when there was a config to delete. */
export async function deleteConfig(path: string): Promise<boolean> {
  try {
    await rm(path)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

/**
 * `KEYSET_API_KEY` for CI, as Stripe's CLI reads `STRIPE_API_KEY`: when set it replaces the stored login entirely.
 * `KEYSET_PROPERTY_ID` names the Property (a key may read several), `KEYSET_API` the API (production by default) and
 * `KEYSET_WEBHOOK_SECRET` the secret `listen` signs with; without it `listen` makes one for the run and prints it.
 * There is deliberately no `--api-key` argument: an argument shows in `ps` and in the shell history.
 */
export function configFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  defaultApi: string,
  makeWebhookSecret: () => string,
): { readonly config: StoredConfig } | { readonly error: string } | null {
  const secretKey = env['KEYSET_API_KEY']
  if (secretKey === undefined || secretKey === '') return null
  if (!SECRET_KEY.test(secretKey))
    return { error: 'KEYSET_API_KEY is not a Keyset secret key (sk_test_… or sk_live_…).' }
  const propertyId = env['KEYSET_PROPERTY_ID'] ?? ''
  if (!UUID.test(propertyId)) return { error: 'With KEYSET_API_KEY, set KEYSET_PROPERTY_ID to the Property id.' }
  const apiBaseUrl = apiOrigin(env['KEYSET_API'] || defaultApi)
  if (!apiBaseUrl) return { error: 'KEYSET_API takes an origin such as https://api-staging.keyset.cloud.' }
  const given = env['KEYSET_WEBHOOK_SECRET']
  if (given && !WEBHOOK_SECRET.test(given)) return { error: 'KEYSET_WEBHOOK_SECRET is not a whsec_ secret.' }
  return {
    config: {
      apiBaseUrl,
      propertyId,
      propertyName: propertyId,
      secretKey,
      test: false,
      webhookSecret: given || makeWebhookSecret(),
      ...(given ? { webhookSecretFromEnvironment: true as const } : {}),
    },
  }
}
