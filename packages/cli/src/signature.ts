import { createHmac, randomBytes } from 'node:crypto'

/**
 * Standard Webhooks (standardwebhooks.com), as Keyset's worker signs: the content is `${id}.${timestamp}.${body}`,
 * the key the base64 part of a `whsec_` secret, the header `v1,` and the base64 HMAC-SHA256.
 */
const PREFIX = 'whsec_'
/** Standard Webhooks allows 24 to 64 key bytes; the CLI makes 32. */
export const WEBHOOK_SECRET = /^whsec_[A-Za-z0-9+/]{32,88}={0,2}$/

/** A local signing secret: 32 random bytes, the same shape as an endpoint secret Keyset issues. */
export function newWebhookSecret(random: (size: number) => Buffer = randomBytes): string {
  return `${PREFIX}${random(32).toString('base64')}`
}

/** The `webhook-signature` header for one message. `timestamp` is whole seconds since the epoch. */
export function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  if (!WEBHOOK_SECRET.test(secret)) throw new TypeError('A webhook secret is whsec_ and base64')
  const key = Buffer.from(secret.slice(PREFIX.length), 'base64')
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`, 'utf8').digest('base64')}`
}
