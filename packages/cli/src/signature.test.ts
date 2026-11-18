import { describe, expect, it } from 'bun:test'
import { signWebhook } from './signature.js'

describe('Standard Webhooks signature', () => {
  it('matches the specification’s published vector and one computed outside Node for a 32-byte secret', () => {
    expect(
      signWebhook(
        'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
        'msg_p5jXN8AQM9LWM0D4loKWxJek',
        1614265330,
        '{"test": 2432232314}',
      ),
    ).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=')
    // Python: hmac.new(bytes(range(32)), b'<id>.<timestamp>.<body>', sha256), base64.
    const id = 'evt_00000000000000000000000000000001'
    expect(signWebhook('whsec_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=', id, 1760000000, `{"id":"${id}"}`)).toBe(
      'v1,vGEM67sawgx2KkPtjytZkbJbFC0PFyDXYJNLt3Uv318=',
    )
  })
})
