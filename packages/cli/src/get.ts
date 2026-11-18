import type { ApiClient } from './api.js'
import type { StoredConfig } from './config.js'
import type { Terminal } from './io.js'

const SEGMENT = /^[A-Za-z0-9_.~-]+$/

/**
 * The request path for `keyset get <path>`: a `/v1/…` path as given, or a path relative to the signed-in Property
 * (`reservations` is `/v1/properties/<id>/reservations`; nothing is the Property itself). A query, `..` or an empty
 * segment is refused; parameters come from `-d name=value`.
 */
export function requestPath(
  path: string | undefined,
  propertyId: string,
  parameters: readonly string[],
): { readonly path: string } | { readonly error: string } {
  const given = path ?? ''
  const absolute = given.startsWith('/')
  const segments = (absolute ? given.slice(1) : given).split('/').filter((segment, index, all) => {
    // A trailing slash is harmless; any other empty segment is not.
    return !(segment === '' && index === all.length - 1)
  })
  if (absolute && segments[0] !== 'v1') return { error: 'A path starting with / must start with /v1/.' }
  for (const segment of segments)
    if (!SEGMENT.test(segment) || segment === '.' || segment === '..')
      return { error: `Not a path Keyset serves: ${given}. Pass parameters with -d name=value.` }
  const query = new URLSearchParams()
  for (const parameter of parameters) {
    const equals = parameter.indexOf('=')
    if (equals < 1) return { error: `-d takes name=value, not ${JSON.stringify(parameter)}.` }
    query.append(parameter.slice(0, equals), parameter.slice(equals + 1))
  }
  const base = absolute
    ? `/${segments.join('/')}`
    : [`/v1/properties/${encodeURIComponent(propertyId)}`, ...segments].join('/')
  const search = query.toString()
  return { path: search ? `${base}?${search}` : base }
}

/**
 * `keyset get` (Stripe's `stripe get`): one read from the API with the stored key, the answer printed as it came,
 * JSON indented. Anything but 2xx exits 1 with the status on stderr and the problem document on stdout.
 */
export async function get(deps: {
  readonly api: Pick<ApiClient, 'get'>
  readonly config: StoredConfig
  readonly path: string
  readonly terminal: Terminal
}): Promise<number> {
  const result = await deps.api.get(deps.config.secretKey, deps.path)
  if (!result.ok) {
    deps.terminal.err(`Could not reach ${deps.config.apiBaseUrl} (${result.reason}).`)
    return 1
  }
  let printed = result.text
  try {
    printed = JSON.stringify(JSON.parse(result.text), null, 2)
  } catch {
    // Not JSON: printed as it came.
  }
  const ok = result.status >= 200 && result.status < 300
  if (!ok) deps.terminal.err(`HTTP ${result.status}`)
  if (printed !== '') deps.terminal.out(printed)
  return ok ? 0 : 1
}
