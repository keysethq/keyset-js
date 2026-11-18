import { describe, expect, it } from 'bun:test'
import { createApiClient } from './api.js'

const secretKey = `sk_test_ks1_${'a'.repeat(32)}_${'Q'.repeat(43)}`
const property = '20000000-0000-4000-8000-000000000001'

function serving(body: unknown) {
  return createApiClient({
    origin: 'https://api.example.test',
    userAgent: 'keyset-cli/test',
    fetch: async () =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
}

const event = (type: unknown) => ({
  id: `evt_${'b'.repeat(32)}`,
  type,
  createdAt: '2026-11-18T09:00:00.000Z',
  data: { unitId: 'u' },
})

describe('listEvents', () => {
  it('keeps an event type a newer server added, so listen can forward it', async () => {
    const result = await serving({
      events: [event('unit.created'), event('reservation.confirmed')],
      hasMore: false,
    }).listEvents(secretKey, property, { after: null, type: null })
    expect(result).toMatchObject({
      ok: true,
      value: { events: [{ type: 'unit.created' }, { type: 'reservation.confirmed' }] },
    })
  })

  it('still refuses a page whose event type is not a dotted name', async () => {
    for (const type of ['', 'Unit Created', 'unit', 42, null]) {
      const result = await serving({ events: [event(type)], hasMore: false }).listEvents(secretKey, property, {
        after: null,
        type: null,
      })
      expect(result.ok).toBe(false)
    }
  })
})
