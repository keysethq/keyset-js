import { describe, expect, it } from 'bun:test'
import { parseCommand } from './args.js'

describe('keyset arguments that guard where a signed event or the key goes', () => {
  it('accepts --skip-verify only for an address on this machine', () => {
    expect(parseCommand(['listen', '--forward-to', 'https://localhost:3000/hooks', '--skip-verify'])).toMatchObject({
      kind: 'listen',
      forward: { url: 'https://localhost:3000/hooks', skipVerify: true },
    })
    for (const url of ['https://example.com/hooks', 'https://127.0.0.1.example.com/hooks'])
      expect(parseCommand(['listen', '--forward-to', url, '--skip-verify'])).toMatchObject({ kind: 'usage' })
  })

  it('lets -H add headers but never replace the signature or the body type', () => {
    expect(parseCommand(['listen', '--forward-to', 'http://localhost:3000', '-H', 'X-Debug: 1'])).toMatchObject({
      forward: { headers: [{ name: 'x-debug', value: '1' }] },
    })
    for (const header of ['Webhook-Signature: v1,forged', 'content-type: text/plain', 'X-Bad: a\r\nb', 'nocolon'])
      expect(parseCommand(['listen', '--forward-to', 'http://localhost:3000', '-H', header])).toMatchObject({
        kind: 'usage',
      })
  })

  it('sends get only to a /v1 path on the configured API', () => {
    for (const path of ['//evil.example/v1', '/v2/x', 'reservations/../../x', 'reservations?limit=1', 'a//b', '%2e%2e'])
      expect(parseCommand(['get', path])).toMatchObject({ kind: 'usage' })
    expect(parseCommand(['get', 'reservations', '-d', 'limit=5'])).toMatchObject({
      kind: 'get',
      path: 'reservations',
      parameters: ['limit=5'],
    })
  })
})
