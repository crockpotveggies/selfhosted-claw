import { describe, expect, it } from 'vitest';

import {
  parseSmsSocketGatewayUrl,
  resolveSmsSocketGatewayUrl,
} from './sms-socket-gateway-url.js';

describe('sms socket gateway URL helpers', () => {
  it('parses websocket URLs and preserves path defaults', () => {
    expect(parseSmsSocketGatewayUrl('ws://127.0.0.1:8787').toString()).toBe(
      'ws://127.0.0.1:8787/',
    );
  });

  it('rejects non-websocket schemes', () => {
    expect(() => parseSmsSocketGatewayUrl('http://1.2.3.4:8787/')).toThrow();
  });

  it('passes private LAN gateway URLs through unchanged (no relay rewrite)', () => {
    // Historically this was rewritten to host.docker.internal via a Windows
    // portproxy relay. That hop is gone — the container connects directly.
    expect(
      resolveSmsSocketGatewayUrl('ws://172.20.1.42:8787/', {
        inContainer: true,
        relayPort: 8787,
      }).toString(),
    ).toBe('ws://172.20.1.42:8787/');
  });

  it('preserves the original host and port regardless of relayPort option', () => {
    expect(
      resolveSmsSocketGatewayUrl('ws://192.168.1.50:8787/', {
        inContainer: true,
        relayPort: null,
      }).toString(),
    ).toBe('ws://192.168.1.50:8787/');
  });
});
