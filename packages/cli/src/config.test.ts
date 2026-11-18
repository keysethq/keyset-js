import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import {
  configFromEnvironment,
  configPath,
  deleteConfig,
  loadConfig,
  maskKey,
  saveConfig,
  shownWebhookSecret,
  type StoredConfig,
} from './config.js'

const stored: StoredConfig = {
  apiBaseUrl: 'https://api-staging.keyset.cloud',
  propertyId: '20000000-0000-4000-8000-000000000001',
  propertyName: 'Seeblick',
  secretKey: `sk_test_ks1_${'0123456789abcdef'.repeat(2)}_${'B'.repeat(43)}`,
  test: true,
  webhookSecret: 'whsec_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
}

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function scratch() {
  const root = await mkdtemp(join(tmpdir(), 'keyset-cli-'))
  roots.push(root)
  return root
}

describe('the stored config', () => {
  it('is written 0600 in a 0700 directory, atomically, and reads back', async () => {
    const root = await scratch()
    const path = configPath({ XDG_CONFIG_HOME: root }, '/nonexistent')
    expect(path).toBe(join(root, 'keyset', 'config.json'))
    await saveConfig(path, stored)
    await saveConfig(path, { ...stored, propertyName: 'Seeblick 2' })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700)
    expect(await readdir(dirname(path))).toEqual(['config.json'])
    expect(await loadConfig(path)).toEqual({ state: 'present', config: { ...stored, propertyName: 'Seeblick 2' } })
  })

  it('treats a tampered file as unreadable rather than trusting it', async () => {
    const root = await scratch()
    const path = join(root, 'config.json')
    await writeFile(path, JSON.stringify({ ...stored, apiBaseUrl: 'http://evil.example' }))
    expect(await loadConfig(path)).toEqual({ state: 'unreadable' })
    await writeFile(path, '{')
    expect(await loadConfig(path)).toEqual({ state: 'unreadable' })
    expect(await deleteConfig(path)).toBe(true)
    expect(await loadConfig(path)).toEqual({ state: 'missing' })
    expect(await deleteConfig(path)).toBe(false)
  })

  it('ignores a relative XDG_CONFIG_HOME and masks the key to its lookup part', () => {
    expect(configPath({ XDG_CONFIG_HOME: 'relative' }, '/home/dev')).toBe('/home/dev/.config/keyset/config.json')
    expect(maskKey(stored.secretKey)).toBe(`sk_test_ks1_${'0123456789abcdef'.repeat(2)}...`)
    expect(maskKey(stored.secretKey)).not.toContain('B'.repeat(10))
  })
})

const secret = () => 'whsec_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='

describe('KEYSET_API_KEY', () => {
  it('replaces the stored login only when the key, the Property and the API are all valid', () => {
    expect(configFromEnvironment({}, 'https://api.keyset.cloud', secret)).toBeNull()
    expect(
      configFromEnvironment(
        { KEYSET_API_KEY: stored.secretKey, KEYSET_PROPERTY_ID: stored.propertyId },
        'https://api.keyset.cloud',
        secret,
      ),
    ).toMatchObject({ config: { apiBaseUrl: 'https://api.keyset.cloud', secretKey: stored.secretKey } })
    for (const env of [
      { KEYSET_API_KEY: 'sk_test_short', KEYSET_PROPERTY_ID: stored.propertyId },
      { KEYSET_API_KEY: stored.secretKey },
      { KEYSET_API_KEY: stored.secretKey, KEYSET_PROPERTY_ID: stored.propertyId, KEYSET_API: 'http://example.com' },
      { KEYSET_API_KEY: stored.secretKey, KEYSET_PROPERTY_ID: stored.propertyId, KEYSET_WEBHOOK_SECRET: 'x' },
    ]) {
      const result = configFromEnvironment(env, 'https://api.keyset.cloud', secret)
      expect(result).toHaveProperty('error')
      expect(JSON.stringify(result)).not.toContain(stored.secretKey)
    }
  })

  it('never prints a signing secret that came from KEYSET_WEBHOOK_SECRET, but shows one it made', () => {
    const env = { KEYSET_API_KEY: stored.secretKey, KEYSET_PROPERTY_ID: stored.propertyId }
    const given = configFromEnvironment(
      { ...env, KEYSET_WEBHOOK_SECRET: stored.webhookSecret },
      'https://api.keyset.cloud',
      secret,
    )
    const made = configFromEnvironment(env, 'https://api.keyset.cloud', secret)
    if (!given || !made || 'error' in given || 'error' in made) throw new Error('expected configs')
    expect(shownWebhookSecret(given.config)).not.toContain('whsec_')
    expect(shownWebhookSecret(made.config)).toBe(secret())
  })
})
