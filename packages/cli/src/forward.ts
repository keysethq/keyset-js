import { request as httpsRequest } from 'node:https'
import { describeNetworkError, type Fetch, type KeysetEvent } from './api.js'
import { signWebhook } from './signature.js'

/** Headers a forwarded message must carry as Keyset signs them; `-H` may not replace these. */
const RESERVED = new Set([
  'content-type',
  'content-length',
  'host',
  'webhook-id',
  'webhook-timestamp',
  'webhook-signature',
])

/** `-H "Name: value"` as a header pair, or a reason it cannot be one. */
export function extraHeader(
  input: string,
): { readonly name: string; readonly value: string } | { readonly error: string } {
  const colon = input.indexOf(':')
  const name = colon > 0 ? input.slice(0, colon).trim().toLowerCase() : ''
  const value = colon > 0 ? input.slice(colon + 1).trim() : ''
  if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name) || /[\r\n\0]/.test(value))
    return { error: `-H takes "Name: value", not ${JSON.stringify(input)}.` }
  if (RESERVED.has(name)) return { error: `-H cannot set ${name}; Keyset's delivery sets it.` }
  return { name, value }
}

/** The body a real delivery carries, in the worker's key order (`webhookEnvelope`). */
export function envelope(event: KeysetEvent, livemode: boolean): string {
  return JSON.stringify({ id: event.id, type: event.type, createdAt: event.createdAt, livemode, data: event.data })
}

export interface ForwardTarget {
  readonly url: string
  readonly headers: readonly { readonly name: string; readonly value: string }[]
  readonly fetch: Fetch
  readonly webhookSecret: string
  readonly userAgent: string
  readonly timeoutMs?: number
}

/**
 * Posts one event to the local address exactly as the worker delivers it, signed with the local secret, and returns
 * what to print: `[status]` or `[failed: reason]`; null when the command was cancelled meanwhile.
 */
export async function forwardEvent(
  target: ForwardTarget,
  event: KeysetEvent,
  options: { readonly livemode: boolean; readonly now: Date; readonly signal: AbortSignal },
): Promise<string | null> {
  const body = envelope(event, options.livemode)
  const timestamp = Math.floor(options.now.getTime() / 1000)
  const headers: Record<string, string> = { 'user-agent': target.userAgent }
  for (const header of target.headers) headers[header.name] = header.value
  headers['content-type'] = 'application/json'
  headers['webhook-id'] = event.id
  headers['webhook-timestamp'] = String(timestamp)
  headers['webhook-signature'] = signWebhook(target.webhookSecret, event.id, timestamp, body)
  try {
    const response = await target.fetch(target.url, {
      method: 'POST',
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.any([AbortSignal.timeout(target.timeoutMs ?? 10_000), options.signal]),
    })
    await response.body?.cancel()
    return `[${response.status}]`
  } catch (error) {
    if (options.signal.aborted) return null
    return `[failed: ${describeNetworkError(error)}]`
  }
}

/**
 * `--skip-verify`: a POST to an https address on this machine that accepts any certificate, for a local server with a
 * self-signed one. Only forwarding uses it, and the arguments allow it only for a loopback address; requests to Keyset
 * always verify. Node's fetch takes no TLS options without a dependency.
 */
export const postSkippingVerify: Fetch = (url, init) =>
  new Promise((resolve, reject) => {
    const target = new URL(url)
    if (target.protocol !== 'https:') {
      fetch(url, init).then(resolve).catch(reject)
      return
    }
    const headers = new Headers(init.headers)
    const request = httpsRequest(
      target,
      {
        method: init.method ?? 'POST',
        headers: Object.fromEntries(headers.entries()),
        rejectUnauthorized: false,
        ...(init.signal ? { signal: init.signal } : {}),
      },
      (response) => {
        response.resume()
        const status = response.statusCode ?? 502
        resolve(new Response(null, { status: status >= 200 && status <= 599 ? status : 502 }))
      },
    )
    request.on('error', reject)
    request.end(typeof init.body === 'string' ? init.body : undefined)
  })
