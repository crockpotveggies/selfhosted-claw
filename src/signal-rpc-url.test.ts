import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveSignalRpcUrl } from './signal-rpc-url.js';

describe('resolveSignalRpcUrl', () => {
  let originalMode: string | undefined;
  beforeEach(() => {
    originalMode = process.env.NANOCLAW_CONTROL_PLANE_NET;
    delete process.env.NANOCLAW_CONTROL_PLANE_NET;
  });
  afterEach(() => {
    if (originalMode === undefined) {
      delete process.env.NANOCLAW_CONTROL_PLANE_NET;
    } else {
      process.env.NANOCLAW_CONTROL_PLANE_NET = originalMode;
    }
  });

  it('rewrites loopback hosts to host.docker.internal in bridge-network containers', () => {
    expect(resolveSignalRpcUrl('http://127.0.0.1:8073', true)).toBe(
      'http://host.docker.internal:8073/',
    );
    expect(resolveSignalRpcUrl('http://localhost:8073/path', true)).toBe(
      'http://host.docker.internal:8073/path',
    );
  });

  it('leaves non-loopback hosts unchanged', () => {
    expect(resolveSignalRpcUrl('http://signal:8073', true)).toBe(
      'http://signal:8073/',
    );
    expect(resolveSignalRpcUrl('http://127.0.0.1:8073', false)).toBe(
      'http://127.0.0.1:8073',
    );
  });

  it('skips the loopback rewrite when running in host-network mode', () => {
    process.env.NANOCLAW_CONTROL_PLANE_NET = 'host';
    expect(resolveSignalRpcUrl('http://127.0.0.1:8073', true)).toBe(
      'http://127.0.0.1:8073',
    );
  });
});
