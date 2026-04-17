import { describe, expect, it } from 'vitest';

import { resolveSignalRpcUrl } from './signal-rpc-url.js';

describe('resolveSignalRpcUrl', () => {
  it('rewrites loopback hosts to host.docker.internal in containers', () => {
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
});
