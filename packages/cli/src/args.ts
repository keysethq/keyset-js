import { parseArgs } from 'node:util'
import { EVENT_TYPES, type EventType, eventType } from './events.js'
import { extraHeader } from './forward.js'
import { requestPath } from './get.js'
import { apiOrigin, forwardUrl, isLoopback, PRODUCTION_API } from './urls.js'

export type CommandName = 'login' | 'logout' | 'status' | 'listen' | 'trigger' | 'events' | 'get' | 'completion'

/** Where and how `listen` and `events resend` post: the address, `-H` headers and `--skip-verify`. */
export interface ForwardOptions {
  readonly url: string
  readonly headers: readonly { readonly name: string; readonly value: string }[]
  readonly skipVerify: boolean
}

export type Shell = 'bash' | 'zsh' | 'fish'

export type Command =
  | { readonly kind: 'help'; readonly topic: CommandName | null }
  | { readonly kind: 'version' }
  | { readonly kind: 'login'; readonly api: string; readonly browser: boolean }
  | { readonly kind: 'logout' }
  | { readonly kind: 'status' }
  | {
      readonly kind: 'listen'
      readonly forward: ForwardOptions | null
      readonly printJson: boolean
      readonly types: readonly EventType[] | null
    }
  | { readonly kind: 'trigger'; readonly type: EventType }
  | { readonly kind: 'events-list'; readonly type: EventType | null; readonly limit: number }
  | { readonly kind: 'events-resend'; readonly id: string; readonly forward: ForwardOptions }
  /** The path is resolved against the Property later; `-d` parameters are checked here already. */
  | { readonly kind: 'get'; readonly path: string | undefined; readonly parameters: readonly string[] }
  | { readonly kind: 'completion'; readonly shell: Shell }
  | { readonly kind: 'usage'; readonly message: string; readonly topic: CommandName | null }

export const COMMANDS: readonly CommandName[] = [
  'login',
  'logout',
  'status',
  'listen',
  'trigger',
  'events',
  'get',
  'completion',
]

/** Every option a command takes, for `keyset completion`. */
export const OPTIONS: Record<CommandName, readonly string[]> = {
  login: ['--api', '--no-browser'],
  logout: [],
  status: [],
  listen: ['--forward-to', '--events', '--print-json', '-H', '--skip-verify'],
  trigger: [],
  events: ['--type', '--limit', '--forward-to', '-H', '--skip-verify'],
  get: ['-d'],
  completion: [],
}

const TYPES = EVENT_TYPES.map((type) => `  ${type}`).join('\n')

export const HELP: Record<CommandName | 'main', string> = {
  main: `keyset: Keyset from the command line

Usage: keyset <command> [options]

Commands:
  login       Sign in through the browser and keep a read-only key for one Property
  logout      Forget the stored key
  status      Show the API, Property and key in use
  listen      Forward new events to a local address, signed like a webhook
  trigger     Create a sample event (test keys only)
  events      List recent events, or send one to a local address again
  get         Read from the API with the stored key, e.g. keyset get events
  completion  Print tab completion for bash, zsh or fish

Options:
  -h, --help     Show help for keyset or a command
  -v, --version  Show the version

Run keyset <command> --help for details.

In CI, set KEYSET_API_KEY and KEYSET_PROPERTY_ID instead of signing in; KEYSET_API
picks the API and KEYSET_WEBHOOK_SECRET the secret listen signs with.`,
  login: `Usage: keyset login [--api <origin>] [--no-browser]

Shows a code, opens Keyset in the browser and waits until you confirm the code there.
Keyset makes a read-only key for the Property you choose; it is kept in
~/.config/keyset/config.json (mode 0600) and is valid for 90 days.

Options:
  --api <origin>   The Keyset API (default ${PRODUCTION_API});
                   https://api-staging.keyset.cloud for staging
  --no-browser     Print the address instead of opening it`,
  logout: `Usage: keyset logout

Deletes the stored key. The key stays valid until it is revoked in Keyset
under Einstellungen › Entwickler.`,
  status: `Usage: keyset status

Shows the API, the Property, test or live, and the start of the stored key.`,
  listen: `Usage: keyset listen --forward-to <url> [--events <type,type>] [options]
       keyset listen --print-json [--events <type,type>]

Starts after the newest event, checks for new ones every two seconds and posts
each to <url> with the body and the webhook-id, webhook-timestamp and
webhook-signature headers of a real delivery (Standard Webhooks). The signing
secret is printed on start. A failed local answer is shown and not retried.

Options:
  --forward-to <url>     Where to post each event, e.g. http://localhost:3000/webhooks
  --events <types>       Only these types, separated by commas
  --print-json           Print each event's body as one line on stdout (with or
                         without --forward-to); messages go to stderr
  -H "Name: value"       Send this header too; repeat for more
  --skip-verify          Accept any certificate from an https address on this machine

Types:
${TYPES}`,
  events: `Usage: keyset events list [--type <type>] [--limit <n>]
       keyset events resend <evt_id> --forward-to <url> [-H "Name: value"] [--skip-verify]

list shows the Property's newest events first (default 10, at most 100); Keyset
keeps them thirty days. resend posts one of them to <url> again, signed with the
CLI's secret like keyset listen does. Endpoints registered in Keyset are resent
from the operator app (Einstellungen › Entwickler).`,
  get: `Usage: keyset get [<path>] [-d name=value ...]

Reads from the Keyset API with the stored key and prints the answer, JSON
indented. A path without a leading slash is under the signed-in Property:

  keyset get                                   the Property
  keyset get reservations/<id>                 one booking
  keyset get reservations/<id>/cancellation-preview
  keyset get events -d type=payment.received -d limit=5

A full /v1/... path is sent as it is. Anything but 2xx exits 1. The key reads
only; there is no post or delete.`,
  completion: `Usage: keyset completion <bash|zsh|fish>

Prints tab completion for the shell. Add it to your shell's start file:

  bash:  echo 'source <(keyset completion bash)' >> ~/.bashrc
  zsh:   echo 'source <(keyset completion zsh)' >> ~/.zshrc
  fish:  keyset completion fish > ~/.config/fish/completions/keyset.fish`,
  trigger: `Usage: keyset trigger <type>

Asks Keyset for one sample event of <type> for the signed-in Property. Only a
test key may do this. The sample's booking or block may not exist; it appears in
keyset listen and is delivered to subscribed webhook endpoints.

Types:
${TYPES}`,
}

function commandName(value: string | undefined): CommandName | null {
  for (const name of COMMANDS) if (value === name) return name
  return null
}

function forwardOptions(
  given: string,
  headers: readonly string[],
  skipVerify: boolean,
): ForwardOptions | { readonly error: string } {
  const url = forwardUrl(given)
  if (!url) return { error: '--forward-to takes an http or https address.' }
  if (skipVerify && !isLoopback(url))
    return { error: '--skip-verify works only for an address on this machine (localhost, 127.0.0.1, [::1]).' }
  const parsed: { name: string; value: string }[] = []
  for (const header of headers) {
    const result = extraHeader(header)
    if ('error' in result) return result
    parsed.push(result)
  }
  return { url, headers: parsed, skipVerify }
}

function problemMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Invalid arguments'
}

export function parseCommand(argv: readonly string[]): Command {
  const [first, ...rest] = argv
  const topic = commandName(first)
  if (!topic) {
    if (first === undefined || first === '-h' || first === '--help' || first === 'help') {
      const named = commandName(rest[0])
      return { kind: 'help', topic: first === 'help' ? named : null }
    }
    if (first === '-v' || first === '--version') return { kind: 'version' }
    return { kind: 'usage', message: `Unknown command: ${first}`, topic: null }
  }
  try {
    switch (topic) {
      case 'login': {
        const { values } = parseArgs({
          args: rest,
          options: {
            api: { type: 'string' },
            'no-browser': { type: 'boolean' },
            help: { type: 'boolean', short: 'h' },
          },
        })
        if (values.help) return { kind: 'help', topic }
        const api = apiOrigin(values.api ?? PRODUCTION_API)
        if (!api)
          return {
            kind: 'usage',
            message: '--api takes an origin such as https://api-staging.keyset.cloud (http only on localhost).',
            topic,
          }
        return { kind: 'login', api, browser: values['no-browser'] !== true }
      }
      case 'logout':
      case 'status': {
        const { values } = parseArgs({ args: rest, options: { help: { type: 'boolean', short: 'h' } } })
        return values.help ? { kind: 'help', topic } : { kind: topic }
      }
      case 'listen': {
        const { values } = parseArgs({
          args: rest,
          options: {
            'forward-to': { type: 'string' },
            events: { type: 'string' },
            'print-json': { type: 'boolean' },
            header: { type: 'string', short: 'H', multiple: true },
            'skip-verify': { type: 'boolean' },
            help: { type: 'boolean', short: 'h' },
          },
        })
        if (values.help) return { kind: 'help', topic }
        const printJson = values['print-json'] === true
        if (values['forward-to'] === undefined && !printJson)
          return { kind: 'usage', message: 'listen needs --forward-to <url> or --print-json.', topic }
        const forward =
          values['forward-to'] === undefined
            ? null
            : forwardOptions(values['forward-to'], values.header ?? [], values['skip-verify'] === true)
        if (forward && 'error' in forward) return { kind: 'usage', message: forward.error, topic }
        if (!forward && (values.header || values['skip-verify']))
          return { kind: 'usage', message: '-H and --skip-verify need --forward-to.', topic }
        if (values.events === undefined) return { kind: 'listen', forward, printJson, types: null }
        const types: EventType[] = []
        for (const name of values.events.split(',').map((part) => part.trim())) {
          const type = eventType(name)
          if (!type) return { kind: 'usage', message: `Unknown event type: ${name}`, topic }
          if (!types.includes(type)) types.push(type)
        }
        return { kind: 'listen', forward, printJson, types }
      }
      case 'events': {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: {
            type: { type: 'string' },
            limit: { type: 'string' },
            'forward-to': { type: 'string' },
            header: { type: 'string', short: 'H', multiple: true },
            'skip-verify': { type: 'boolean' },
            help: { type: 'boolean', short: 'h' },
          },
        })
        if (values.help) return { kind: 'help', topic }
        const [action, id, ...extra] = positionals
        if (action === 'list' && id === undefined) {
          if (values['forward-to'] !== undefined || values.header || values['skip-verify'])
            return { kind: 'usage', message: 'events list takes --type and --limit only.', topic }
          const type = values.type === undefined ? null : eventType(values.type)
          if (type === null && values.type !== undefined)
            return { kind: 'usage', message: `Unknown event type: ${values.type}`, topic }
          const limit = values.limit === undefined ? 10 : Number(values.limit)
          if (!Number.isInteger(limit) || limit < 1 || limit > 100)
            return { kind: 'usage', message: '--limit takes a whole number from 1 to 100.', topic }
          return { kind: 'events-list', type, limit }
        }
        if (action === 'resend' && id !== undefined && extra.length === 0) {
          if (!/^evt_[a-f0-9]{32}$/.test(id)) return { kind: 'usage', message: `Not an event id: ${id}`, topic }
          if (values.type !== undefined || values.limit !== undefined)
            return { kind: 'usage', message: 'events resend takes no --type or --limit.', topic }
          if (values['forward-to'] === undefined)
            return { kind: 'usage', message: 'events resend needs --forward-to <url>.', topic }
          const forward = forwardOptions(values['forward-to'], values.header ?? [], values['skip-verify'] === true)
          if ('error' in forward) return { kind: 'usage', message: forward.error, topic }
          return { kind: 'events-resend', id, forward }
        }
        return { kind: 'usage', message: 'events takes list, or resend <evt_id>.', topic }
      }
      case 'get': {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: { data: { type: 'string', short: 'd', multiple: true }, help: { type: 'boolean', short: 'h' } },
        })
        if (values.help) return { kind: 'help', topic }
        if (positionals.length > 1) return { kind: 'usage', message: 'get takes one path.', topic }
        const [path] = positionals
        const parameters = values.data ?? []
        // Checked against a placeholder Property now, so a wrong path fails before any key is read.
        const checked = requestPath(path, '00000000-0000-4000-8000-000000000000', parameters)
        if ('error' in checked) return { kind: 'usage', message: checked.error, topic }
        return { kind: 'get', path, parameters }
      }
      case 'completion': {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: { help: { type: 'boolean', short: 'h' } },
        })
        if (values.help) return { kind: 'help', topic }
        const [shell] = positionals
        if (positionals.length !== 1 || (shell !== 'bash' && shell !== 'zsh' && shell !== 'fish'))
          return { kind: 'usage', message: 'completion takes bash, zsh or fish.', topic }
        return { kind: 'completion', shell }
      }
      default: {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: { help: { type: 'boolean', short: 'h' } },
        })
        if (values.help) return { kind: 'help', topic }
        if (positionals.length !== 1) return { kind: 'usage', message: 'trigger takes one event type.', topic }
        const type = eventType(positionals[0])
        if (!type) return { kind: 'usage', message: `Unknown event type: ${positionals[0]}`, topic }
        return { kind: 'trigger', type }
      }
    }
  } catch (error) {
    return { kind: 'usage', message: problemMessage(error), topic }
  }
}
