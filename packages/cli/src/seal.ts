import {
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
} from 'node:crypto'

/**
 * ADR-051 §2: Keyset seals the new secret key to the CLI's X25519 public key. The sealed form is
 * `v1.<ephemeral public>.<nonce>.<ciphertext and 16-byte tag>`, all base64url; the AES-256-GCM key is HKDF-SHA256 of
 * the X25519 agreement, salted with `${ephemeralPublic}.${cliPublicKey}` and labelled `keyset-cli-pairing-v1`.
 */
const INFO = 'keyset-cli-pairing-v1'
const RAW_KEY = /^[A-Za-z0-9_-]{43}$/
const NONCE = /^[A-Za-z0-9_-]{16}$/
const BODY = /^[A-Za-z0-9_-]{22,}$/
const TAG_BYTES = 16

export interface CliKeyPair {
  /** The raw 32-byte public key in base64url, which is the JWK `x`. */
  readonly publicKey: string
  readonly privateKey: KeyObject
}

export function createCliKeyPair(): CliKeyPair {
  const pair = generateKeyPairSync('x25519')
  const publicKey = pair.publicKey.export({ format: 'jwk' }).x
  if (typeof publicKey !== 'string' || !RAW_KEY.test(publicKey)) throw new Error('Could not export an X25519 key')
  return { publicKey, privateKey: pair.privateKey }
}

/** The plain text, or null for anything this key pair did not receive intact. */
export function openSealed(sealed: string, keyPair: CliKeyPair): string | null {
  const parts = sealed.split('.')
  if (parts.length !== 4) return null
  const [version, ephemeral, nonce, body] = parts
  if (version !== 'v1' || !ephemeral || !nonce || !body) return null
  if (!RAW_KEY.test(ephemeral) || !NONCE.test(nonce) || !BODY.test(body)) return null
  try {
    const sender = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: ephemeral }, format: 'jwk' })
    const shared = diffieHellman({ privateKey: keyPair.privateKey, publicKey: sender })
    const key = Buffer.from(hkdfSync('sha256', shared, Buffer.from(`${ephemeral}.${keyPair.publicKey}`), INFO, 32))
    const bytes = Buffer.from(body, 'base64url')
    if (bytes.length <= TAG_BYTES) return null
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64url'), { authTagLength: 16 })
    decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES))
    return Buffer.concat([decipher.update(bytes.subarray(0, bytes.length - TAG_BYTES)), decipher.final()]).toString(
      'utf8',
    )
  } catch {
    return null
  }
}
