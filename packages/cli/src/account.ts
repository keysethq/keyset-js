import { deleteConfig, isLiveKey, loadConfig, maskKey, type StoredConfig } from './config.js'
import type { Terminal } from './io.js'

const REVOKE_HINT = 'The key itself stays valid until it is revoked in Keyset under Einstellungen › Entwickler.'

/** `keyset status`: where the CLI points and with which key, never the key itself. */
export async function status(
  configPath: string,
  terminal: Terminal,
  fromEnvironment: StoredConfig | null = null,
): Promise<number> {
  if (fromEnvironment) {
    terminal.out(`API:       ${fromEnvironment.apiBaseUrl}`)
    terminal.out(`Property:  ${fromEnvironment.propertyId}`)
    terminal.out(`Mode:      ${isLiveKey(fromEnvironment.secretKey) ? 'live' : 'test'}`)
    terminal.out(`Key:       ${maskKey(fromEnvironment.secretKey)} (from KEYSET_API_KEY; the stored login is not used)`)
    return 0
  }
  const loaded = await loadConfig(configPath)
  if (loaded.state === 'missing') {
    terminal.out('Not signed in. Run keyset login.')
    return 1
  }
  if (loaded.state === 'unreadable') {
    terminal.err(`${configPath} cannot be read. Run keyset login again.`)
    return 1
  }
  const { config } = loaded
  terminal.out(`API:       ${config.apiBaseUrl}`)
  terminal.out(`Property:  ${config.propertyName}${config.test ? ' (test business)' : ''}`)
  terminal.out(`           ${config.propertyId}`)
  terminal.out(`Mode:      ${isLiveKey(config.secretKey) ? 'live' : 'test'}`)
  terminal.out(`Key:       ${maskKey(config.secretKey)}`)
  terminal.out(`Config:    ${configPath}`)
  return 0
}

/** `keyset logout`: forget the key here. Revoking it is a decision made in Keyset. */
export async function logout(configPath: string, terminal: Terminal): Promise<number> {
  const deleted = await deleteConfig(configPath)
  terminal.out(deleted ? `Signed out; ${configPath} is deleted.` : 'Not signed in; nothing to delete.')
  if (deleted) terminal.out(REVOKE_HINT)
  return 0
}
