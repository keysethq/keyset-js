import type { ApiClient, ApiFailure } from './api.js'
import { isLiveKey, loadConfig, SECRET_KEY, saveConfig } from './config.js'
import type { Sleep, Terminal } from './io.js'
import { type CliKeyPair, createCliKeyPair, openSealed } from './seal.js'
import { newWebhookSecret } from './signature.js'
import { browsableUrl } from './urls.js'

export interface LoginDependencies {
  readonly api: Pick<ApiClient, 'startPairing' | 'collectPairing'>
  readonly apiBaseUrl: string
  readonly configPath: string
  readonly deviceName: string
  readonly terminal: Terminal
  readonly sleep: Sleep
  readonly now: () => Date
  /** Best effort; null when no browser is to be opened. */
  readonly openBrowser: ((url: string) => void) | null
  readonly keyPair?: CliKeyPair
  readonly newWebhookSecret?: () => string
  readonly signal?: AbortSignal
}

const POLL_CEILING_SECONDS = 30

function startFailure(failure: ApiFailure, origin: string): string {
  if (failure.kind === 'network')
    return `Could not reach ${origin} (${failure.reason}). Check the address and try again.`
  if (failure.kind === 'malformed')
    return `${origin} answered in a way this CLI does not understand. Is it a Keyset API?`
  if (failure.status === 429) return 'Too many sign-in attempts from here. Wait a minute and try again.'
  if (failure.status === 503) return `Signing in from the command line is not set up on ${origin}.`
  if (failure.status === 404) return `${origin} does not offer command-line sign-in. Is it a Keyset API?`
  return `${origin} refused to start a sign-in (status ${failure.status}).`
}

function collectFailure(code: string | null): string {
  switch (code) {
    case 'PAIRING_DENIED':
      return 'The sign-in was refused in the browser. Nothing was saved.'
    case 'PAIRING_EXPIRED':
      return 'The code lapsed before it was confirmed. Run keyset login again.'
    case 'PAIRING_COLLECTED':
      return 'This sign-in was already collected by another process. Run keyset login again.'
    default:
      return 'Keyset no longer knows this sign-in. Run keyset login again.'
  }
}

/**
 * `keyset login` (ADR-051 §2): show a code, let the person confirm it in Keyset, collect the sealed key once and keep
 * it. The pairing secret and the key never reach the terminal.
 */
export async function login(deps: LoginDependencies): Promise<number> {
  const { terminal } = deps
  const keyPair = deps.keyPair ?? createCliKeyPair()
  const started = await deps.api.startPairing({ publicKey: keyPair.publicKey, deviceName: deps.deviceName })
  if (!started.ok) {
    terminal.err(startFailure(started.failure, deps.apiBaseUrl))
    return 1
  }
  const pairing = started.value
  // Rebuilt from the server's origin and the checked code, so no character the server chose reaches a shell or opener.
  const origin = browsableUrl(pairing.verificationUrl)
  const verificationUrl =
    origin && /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/.test(pairing.userCode)
      ? `${new URL(origin).origin}/cli?code=${pairing.userCode}`
      : null
  terminal.out('')
  terminal.out(`  Your confirmation code:  ${pairing.userCode}`)
  terminal.out('')
  if (verificationUrl) {
    terminal.out('Open this address, sign in to Keyset and confirm the same code:')
    terminal.out(`  ${verificationUrl}`)
  } else {
    terminal.out('Sign in to Keyset and confirm the same code under Einstellungen › Entwickler.')
  }
  terminal.out('Only confirm a code you have just started yourself.')
  terminal.out('')
  if (verificationUrl && deps.openBrowser) deps.openBrowser(verificationUrl)
  terminal.out('Waiting for confirmation (Ctrl-C to cancel)...')

  const expiresAt = Date.parse(pairing.expiresAt)
  let interval = pairing.intervalSeconds
  let unreachable = false
  while (deps.now().getTime() < expiresAt) {
    await deps.sleep(interval * 1000, deps.signal)
    if (deps.signal?.aborted) {
      terminal.err('Cancelled. Nothing was saved.')
      return 130
    }
    const collected = await deps.api.collectPairing(pairing.pairingSecret)
    if (!collected.ok) {
      const failure = collected.failure
      if (failure.kind === 'problem' && (failure.status === 410 || failure.status === 404)) {
        terminal.err(collectFailure(failure.code))
        return 1
      }
      if (failure.kind === 'problem' && failure.status === 429) {
        // RFC 8628's slow_down: wait longer from now on.
        interval = Math.min(interval + 5, POLL_CEILING_SECONDS)
        continue
      }
      if (!unreachable) {
        const reason = failure.kind === 'network' ? failure.reason : `status ${failure.status}`
        terminal.err(`Could not ask Keyset for the result (${reason}). Still trying.`)
        unreachable = true
      }
      continue
    }
    unreachable = false
    const answer = collected.value
    if (answer.status === 'pending') continue
    const secretKey = openSealed(answer.sealedKey, keyPair)
    if (!secretKey || !SECRET_KEY.test(secretKey)) {
      terminal.err('Keyset sent a key this device cannot open. Nothing was saved.')
      terminal.err('Revoke the new key in Einstellungen › Entwickler and run keyset login again.')
      return 1
    }
    // A receiver is configured with the signing secret once; signing in again (a key lasts 90 days) keeps it.
    const previous = await loadConfig(deps.configPath)
    const webhookSecret =
      previous.state === 'present'
        ? previous.config.webhookSecret
        : (deps.newWebhookSecret ?? (() => newWebhookSecret()))()
    await saveConfig(deps.configPath, {
      apiBaseUrl: deps.apiBaseUrl,
      propertyId: answer.propertyId,
      propertyName: answer.propertyName,
      secretKey,
      test: answer.test,
      webhookSecret,
    })
    const business = answer.test ? ' (test business)' : ''
    const mode = isLiveKey(secretKey) ? 'live' : 'test'
    terminal.out(`Signed in to ${answer.propertyName}${business} with a ${mode} key, read-only, valid for 90 days.`)
    terminal.out(`Saved to ${deps.configPath}.`)
    return 0
  }
  terminal.err('The code lapsed before it was confirmed. Run keyset login again.')
  return 1
}
