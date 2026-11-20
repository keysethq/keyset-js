import { describe, expect, test } from 'bun:test'
import { parseQuote, ShapeError } from './validate.js'

describe('tiered cancellation terms (1.1.0)', () => {
  test('a quote reads bound tiers and the arrival time, and a malformed tier is refused', () => {
    const base = {
      publicQuoteReference: 'q'.repeat(22),
      expiresAt: '2026-11-20T10:00:00Z',
      unit: { publicUnitReference: 'u'.repeat(22), displayName: 'Apartment' },
      stay: { checkIn: '2027-01-10', checkOut: '2027-01-12', nights: 2 },
      occupancy: { adults: 2, children: 0 },
      total: { minorUnits: '20000', currency: 'EUR' },
      dueNow: { minorUnits: '20000', currency: 'EUR' },
      lineItems: [],
      authoritative: true,
    }
    const tier = { hoursBeforeArrival: 168, refundBasisPoints: 10_000, until: '2027-01-03T15:00' }
    const parsed = parseQuote({
      ...base,
      cancellation: { freeUntil: '2027-01-03', refundTiers: [tier], arrivalTime: '15:00' },
    })
    expect(parsed.cancellation?.refundTiers).toEqual([tier])
    expect(parsed.cancellation?.arrivalTime).toBe('15:00')
    expect(parseQuote({ ...base, cancellation: { freeUntil: null } }).cancellation).toEqual({ freeUntil: null })
    expect(() =>
      parseQuote({ ...base, cancellation: { freeUntil: null, refundTiers: [{ ...tier, until: 'tomorrow' }] } }),
    ).toThrow(ShapeError)
    expect(() => parseQuote({ ...base, cancellation: { freeUntil: null, refundTiers: [] } })).toThrow(ShapeError)
  })
})
