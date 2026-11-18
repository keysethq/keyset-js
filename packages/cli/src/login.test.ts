import { createCipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { ApiClient, ApiResult, PairingCollected, PairingStarted } from './api.js'
import { loadConfig } from './config.js'
import { login } from './login.js'
import { createCliKeyPair } from './seal.js'

/** The server's `sealToCli` (packages/application/src/cli-pairing.ts), copied as a fixture. */
function sealToCli(plain: string, cliPublicKey: string): string {
  const recipient = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: cliPublicKey }, format: 'jwk' })
  const ephemeral = generateKeyPairSync('x25519')
  const ephemeralPublic = ephemeral.publicKey.export({ format: 'jwk' }).x ?? ''
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient })
  const key = Buffer.from(
    hkdfSync('sha256', shared, Buffer.from(`${ephemeralPublic}.${cliPublicKey}`), 'keyset-cli-pairing-v1', 32),
  )
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final(), cipher.getAuthTag()])
  return ['v1', ephemeralPublic, nonce.toString('base64url'), body.toString('base64url')].join('.')
}

const secretKey = `sk_test_ks1_${'a'.repeat(32)}_${'Q'.repeat(43)}`
const pairingSecret = `kcp_${'P'.repeat(43)}`
const property = '20000000-0000-4000-8000-000000000001'
const T0 = Date.UTC(2026, 9, 15, 9, 0, 0)

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function setup(options: {
  readonly answers: (keyPairPublic: string) => ApiResult<PairingCollected>[]
  readonly verificationUrl?: string
  readonly configPath?: string
  readonly webhookSecret?: string
}) {
  const configPath = options.configPath ?? join(await mkdtemp(join(tmpdir(), 'keyset-login-')), 'keyset', 'config.json')
  roots.push(configPath)
  const keyPair = createCliKeyPair()
  const started: PairingStarted = {
    pairingSecret,
    userCode: 'BCDF-GHJK',
    verificationUrl: options.verificationUrl ?? 'https://staging.keyset.cloud/cli?code=BCDF-GHJK',
    expiresAt: new Date(T0 + 600_000).toISOString(),
    intervalSeconds: 2,
  }
  const answers = options.answers(keyPair.publicKey)
  const startPairing = mock<ApiClient['startPairing']>().mockResolvedValue({ ok: true, value: started })
  const collectPairing = mock<ApiClient['collectPairing']>().mockImplementation(
    async () => answers.shift() ?? { ok: true, value: { status: 'pending' } },
  )
  const openBrowser = mock<(url: string) => void>()
  const lines: string[] = []
  let now = T0
  const code = await login({
    api: { startPairing, collectPairing },
    apiBaseUrl: 'https://api-staging.keyset.cloud',
    configPath,
    deviceName: 'laptop',
    terminal: { out: (line) => lines.push(line), err: (line) => lines.push(line) },
    sleep: async (milliseconds) => {
      now += milliseconds
    },
    now: () => new Date(now),
    openBrowser,
    keyPair,
    newWebhookSecret: () => options.webhookSecret ?? 'whsec_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
  })
  return { code, configPath, lines, startPairing, collectPairing, openBrowser, keyPair }
}

const approved = (publicKey: string): ApiResult<PairingCollected> => ({
  ok: true,
  value: {
    status: 'approved',
    sealedKey: sealToCli(secretKey, publicKey),
    propertyId: property,
    propertyName: 'Seeblick',
    test: true,
  },
})

describe('keyset login', () => {
  it('waits for the browser, opens the sealed key and stores it without printing a secret', async () => {
    const result = await setup({ answers: (key) => [{ ok: true, value: { status: 'pending' } }, approved(key)] })
    expect(result.code).toBe(0)
    expect(result.startPairing).toHaveBeenCalledWith({ publicKey: result.keyPair.publicKey, deviceName: 'laptop' })
    expect(result.collectPairing).toHaveBeenCalledTimes(2)
    expect(result.openBrowser).toHaveBeenCalledWith('https://staging.keyset.cloud/cli?code=BCDF-GHJK')
    expect(await loadConfig(result.configPath)).toEqual({
      state: 'present',
      config: {
        apiBaseUrl: 'https://api-staging.keyset.cloud',
        propertyId: property,
        propertyName: 'Seeblick',
        secretKey,
        test: true,
        webhookSecret: 'whsec_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
      },
    })
    const printed = result.lines.join('\n')
    expect(printed).toContain('BCDF-GHJK')
    expect(printed).not.toContain('Q'.repeat(43))
    expect(printed).not.toContain(pairingSecret)
  })

  it('opens only a web address it built itself, so nothing the server sends reaches a shell', async () => {
    const result = await setup({
      answers: (key) => [approved(key)],
      verificationUrl: 'https://staging.keyset.cloud/x?code=BCDF-GHJK&calc.exe|whoami^',
    })
    expect(result.openBrowser).toHaveBeenCalledWith('https://staging.keyset.cloud/cli?code=BCDF-GHJK')
    const file = await setup({ answers: (key) => [approved(key)], verificationUrl: 'file:///etc/passwd' })
    expect(file.openBrowser).not.toHaveBeenCalled()
    expect(file.lines.join('\n')).not.toContain('file:')
  })
})
