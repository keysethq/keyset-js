import { describe, expect, it } from 'bun:test'
import { createCliKeyPair, openSealed } from './seal.js'

/**
 * An independent sealer written from ADR-051 §2 with WebCrypto, not node:crypto's helpers the opener uses: ephemeral
 * X25519, HKDF-SHA256 (salt `${ephemeralPublic}.${cliPublicKey}`, info `keyset-cli-pairing-v1`), AES-256-GCM.
 */
const encoder = new TextEncoder()
const b64url = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(new Uint8Array(bytes)).toString('base64url')

async function seal(
  plain: string,
  cliPublicKey: string,
  variant: { readonly salt?: (ephemeral: string) => string; readonly info?: string } = {},
): Promise<string> {
  const subtle = globalThis.crypto.subtle
  const recipient = await subtle.importKey(
    'raw',
    new Uint8Array(Buffer.from(cliPublicKey, 'base64url')),
    { name: 'X25519' },
    false,
    [],
  )
  const ephemeral = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])
  if (!('privateKey' in ephemeral)) throw new Error('expected a key pair')
  const ephemeralPublic = b64url(await subtle.exportKey('raw', ephemeral.publicKey))
  const shared = await subtle.deriveBits({ name: 'X25519', public: recipient }, ephemeral.privateKey, 256)
  const hkdf = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  const salt = variant.salt ? variant.salt(ephemeralPublic) : `${ephemeralPublic}.${cliPublicKey}`
  const key = await subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode(salt),
      info: encoder.encode(variant.info ?? 'keyset-cli-pairing-v1'),
    },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  )
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const body = await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, encoder.encode(plain))
  return ['v1', ephemeralPublic, b64url(nonce), b64url(body)].join('.')
}

const secret = `sk_test_ks1_${'a'.repeat(32)}_${'B'.repeat(43)}`

describe('opening the sealed key', () => {
  it('opens what a sealer following the ADR seals', async () => {
    const pair = createCliKeyPair()
    expect(openSealed(await seal(secret, pair.publicKey), pair)).toBe(secret)
  })

  it('refuses a seal made with a different salt or info, for another key pair, or with any changed byte', async () => {
    const pair = createCliKeyPair()
    expect(openSealed(await seal(secret, pair.publicKey, { salt: (ephemeral) => ephemeral }), pair)).toBeNull()
    expect(
      openSealed(await seal(secret, pair.publicKey, { salt: (ephemeral) => `${pair.publicKey}.${ephemeral}` }), pair),
    ).toBeNull()
    expect(openSealed(await seal(secret, pair.publicKey, { info: 'keyset-cli-pairing-v2' }), pair)).toBeNull()
    expect(openSealed(await seal(secret, createCliKeyPair().publicKey), pair)).toBeNull()
    const sealed = await seal(secret, pair.publicKey)
    const parts = sealed.split('.')
    const body = Buffer.from(parts[3] ?? '', 'base64url')
    body[0] = (body[0] ?? 0) ^ 1
    expect(openSealed([parts[0], parts[1], parts[2], body.toString('base64url')].join('.'), pair)).toBeNull()
    expect(openSealed(sealed.replace(/^v1/, 'v2'), pair)).toBeNull()
    expect(openSealed(`${sealed}.extra`, pair)).toBeNull()
  })
})
