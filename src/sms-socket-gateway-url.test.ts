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

  it('rewrites private LAN gateway URLs through host relay in containers', () => {
    expect(
      resolveSmsSocketGatewayUrl('ws://172.20.1.42:8787/', {
        inContainer: true,
        relayPort: 8787,
      }).toString(),
    ).toBe('ws://host.docker.internal:8787/');
  });

  it('defaults to the original gateway port when relay port is not configured', () => {
    expect(
      resolveSmsSocketGatewayUrl('ws://172.20.1.42:8787/', {
        inContainer: true,
        relayPort: null,
      }).toString(),
    ).toBe('ws://host.docker.internal:8787/');
  });
});
