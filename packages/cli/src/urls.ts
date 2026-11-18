/** The production API; only a live key against it delivers `livemode: true`, as the worker does. */
export const PRODUCTION_API = 'https://api.keyset.cloud'

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * An API origin the CLI will send a secret key to: any https origin, or plain http on this machine for local
 * development. A path, query or credentials in the address are refused rather than silently dropped.
 */
export function apiOrigin(input: string): string | null {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return null
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null
  if (url.protocol === 'https:') return url.origin
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return url.origin
  return null
}

/** An address Keyset may ask the CLI to open in a browser: https, or http on this machine. */
export function browsableUrl(input: string): string | null {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return null
  }
  if (url.username || url.password) return null
  if (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname))) return url.href
  return null
}

/** Where `listen` forwards to: any http(s) address, usually a local one. */
export function forwardUrl(input: string): string | null {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return null
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
}

/** True for an address on this machine: the only place `--skip-verify` may forward to. */
export function isLoopback(input: string): boolean {
  try {
    return LOOPBACK.has(new URL(input).hostname)
  } catch {
    return false
  }
}
