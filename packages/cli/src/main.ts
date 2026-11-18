#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { logout, status } from './account.js'
import { createApiClient } from './api.js'
import { type Command, type ForwardOptions, HELP, parseCommand } from './args.js'
import { completionScript } from './completion.js'
import { configFromEnvironment, configPath, loadConfig, type StoredConfig } from './config.js'
import { listEventsCommand, resendEventCommand } from './event-commands.js'
import { postSkippingVerify } from './forward.js'
import { get, requestPath } from './get.js'
import { sleep, type Terminal } from './io.js'
import { listen } from './listen.js'
import { login } from './login.js'
import { newWebhookSecret } from './signature.js'
import { trigger } from './trigger.js'
import { PRODUCTION_API } from './urls.js'

function version(): string {
  try {
    const manifest: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    if (manifest && typeof manifest === 'object' && 'version' in manifest && typeof manifest.version === 'string')
      return manifest.version
  } catch {
    // Fall through: a missing manifest does not stop the CLI.
  }
  return '0.0.0'
}

const terminal: Terminal = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
}

/** Best effort: a missing opener or a headless machine only means the person opens the printed address. */
function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? // Not `cmd /c start`: cmd would read & | ^ in an address as its own syntax.
          ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]]
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => undefined)
    child.unref()
  } catch {
    // Ignored: the address is printed.
  }
}

function forwarding(options: ForwardOptions, userAgent: string) {
  return {
    url: options.url,
    headers: options.headers,
    fetch: options.skipVerify ? postSkippingVerify : fetch,
    userAgent,
  }
}

/** Ctrl-C aborts the returned signal once; a second Ctrl-C ends the process the default way. */
function interruptSignal(): AbortSignal {
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort())
  process.once('SIGTERM', () => controller.abort())
  return controller.signal
}

/** KEYSET_API_KEY and friends, checked once; an invalid setting stops every command that needs a key. */
const environment = configFromEnvironment(process.env, PRODUCTION_API, () => newWebhookSecret())

async function signedIn(path: string): Promise<StoredConfig | null> {
  if (environment) {
    if ('config' in environment) return environment.config
    terminal.err(environment.error)
    return null
  }
  const loaded = await loadConfig(path)
  if (loaded.state === 'present') return loaded.config
  terminal.err(
    loaded.state === 'missing' ? 'Not signed in. Run keyset login.' : `${path} cannot be read. Run keyset login again.`,
  )
  return null
}

async function run(command: Command): Promise<number> {
  const path = configPath(process.env, homedir())
  const userAgent = `Keyset-CLI/${version()}`
  switch (command.kind) {
    case 'help':
      terminal.out(HELP[command.topic ?? 'main'])
      return 0
    case 'version':
      terminal.out(version())
      return 0
    case 'usage':
      terminal.err(command.message)
      terminal.err(`Run keyset ${command.topic ? `${command.topic} ` : ''}--help for usage.`)
      return 2
    case 'logout':
      return logout(path, terminal)
    case 'status':
      if (environment && 'error' in environment) {
        terminal.err(environment.error)
        return 1
      }
      return status(path, terminal, environment?.config ?? null)
    case 'completion':
      process.stdout.write(completionScript(command.shell))
      return 0
    case 'get': {
      const config = await signedIn(path)
      if (!config) return 1
      const resolved = requestPath(command.path, config.propertyId, command.parameters)
      if ('error' in resolved) {
        terminal.err(resolved.error)
        return 2
      }
      return get({
        api: createApiClient({ origin: config.apiBaseUrl, fetch, userAgent, signal: interruptSignal() }),
        config,
        path: resolved.path,
        terminal,
      })
    }
    case 'events-list': {
      const config = await signedIn(path)
      if (!config) return 1
      return listEventsCommand({
        api: createApiClient({ origin: config.apiBaseUrl, fetch, userAgent, signal: interruptSignal() }),
        config,
        type: command.type,
        limit: command.limit,
        terminal,
      })
    }
    case 'events-resend': {
      const config = await signedIn(path)
      if (!config) return 1
      const signal = interruptSignal()
      return resendEventCommand({
        api: createApiClient({ origin: config.apiBaseUrl, fetch, userAgent, signal }),
        config,
        id: command.id,
        forward: forwarding(command.forward, userAgent),
        terminal,
        now: () => new Date(),
        signal,
      })
    }
    case 'login': {
      const signal = interruptSignal()
      return login({
        api: createApiClient({ origin: command.api, fetch, userAgent, signal }),
        apiBaseUrl: command.api,
        configPath: path,
        deviceName: hostname(),
        terminal,
        sleep,
        now: () => new Date(),
        openBrowser: command.browser ? openBrowser : null,
        signal,
      })
    }
    case 'listen': {
      const config = await signedIn(path)
      if (!config) return 1
      const signal = interruptSignal()
      const code = await listen({
        api: createApiClient({ origin: config.apiBaseUrl, fetch, userAgent, signal }),
        config,
        forward: command.forward ? forwarding(command.forward, userAgent) : null,
        printJson: command.printJson,
        types: command.types,
        terminal,
        sleep,
        now: () => new Date(),
        signal,
      })
      if (signal.aborted) terminal.out('Stopped.')
      return code
    }
    default: {
      const config = await signedIn(path)
      if (!config) return 1
      return trigger({
        api: createApiClient({ origin: config.apiBaseUrl, fetch, userAgent }),
        config,
        type: command.type,
        terminal,
      })
    }
  }
}

try {
  process.exitCode = await run(parseCommand(process.argv.slice(2)))
} catch (error) {
  terminal.err(`keyset failed: ${error instanceof Error ? error.message : 'unknown error'}`)
  process.exitCode = 1
}
