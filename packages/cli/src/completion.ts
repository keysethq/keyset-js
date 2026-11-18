import { COMMANDS, OPTIONS, type Shell } from './args.js'
import { EVENT_TYPES } from './events.js'

/** Words that may follow a command besides its options: event types and subcommands. */
const ARGUMENTS: Partial<Record<(typeof COMMANDS)[number], readonly string[]>> = {
  trigger: EVENT_TYPES,
  events: ['list', 'resend'],
  completion: ['bash', 'zsh', 'fish'],
}

function words(command: (typeof COMMANDS)[number]): string {
  return [...(ARGUMENTS[command] ?? []), ...OPTIONS[command], '--help'].join(' ')
}

function bash(): string {
  const cases = COMMANDS.map((command) => `    ${command}) words="${words(command)}" ;;`).join('\n')
  return `# keyset tab completion for bash (keyset completion bash)
_keyset() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" prev="\${COMP_WORDS[COMP_CWORD-1]}" words
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=($(compgen -W "${COMMANDS.join(' ')} --help --version" -- "$cur"))
    return
  fi
  if [ "$prev" = "--events" ] || [ "$prev" = "--type" ]; then
    COMPREPLY=($(compgen -W "${EVENT_TYPES.join(' ')}" -- "$cur"))
    return
  fi
  case "\${COMP_WORDS[1]}" in
${cases}
    *) words="" ;;
  esac
  COMPREPLY=($(compgen -W "$words" -- "$cur"))
}
complete -F _keyset keyset
`
}

function fish(): string {
  const lines = [
    '# keyset tab completion for fish (keyset completion fish)',
    'complete -c keyset -f',
    `complete -c keyset -n __fish_use_subcommand -a "${COMMANDS.join(' ')}"`,
  ]
  for (const command of COMMANDS) {
    const when = `"__fish_seen_subcommand_from ${command}"`
    const argumentsOf = ARGUMENTS[command]
    if (argumentsOf) lines.push(`complete -c keyset -n ${when} -a "${argumentsOf.join(' ')}"`)
    for (const option of OPTIONS[command]) {
      const flag = option.startsWith('--') ? `-l ${option.slice(2)}` : `-s ${option.slice(1)}`
      const takes = option === '--events' || option === '--type' ? ` -r -a "${EVENT_TYPES.join(' ')}"` : ''
      lines.push(`complete -c keyset -n ${when} ${flag}${takes}`)
    }
  }
  return `${lines.join('\n')}\n`
}

/** `keyset completion <shell>`: zsh reuses the bash function through bashcompinit. */
export function completionScript(shell: Shell): string {
  if (shell === 'fish') return fish()
  if (shell === 'zsh')
    return `(( $+functions[compdef] )) || { autoload -U +X compinit && compinit }
autoload -U +X bashcompinit && bashcompinit
${bash().replace('for bash', 'for zsh')}`
  return bash()
}
