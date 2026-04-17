import { describe, expect, it } from 'vitest';

import { resolveSmsSocketRelayTarget } from './sms-socket-relay.js';

describe('sms socket relay target resolution', () => {
  it('uses the gateway port as the default relay port', () => {
    expect(resolveSmsSocketRelayTarget('ws://172.20.1.42:8787/')).toEqual({
      gatewayHost: '172.20.1.42',
      gatewayPort: 8787,
      listenPort: 8787,
    });
  });

  it('respects an explicit relay listen port', () => {
    expect(
      resolveSmsSocketRelayTarget('ws://172.20.1.42:8787/', 18787),
    ).toEqual({
      gatewayHost: '172.20.1.42',
      gatewayPort: 8787,
      listenPort: 18787,
    });
  });
});
