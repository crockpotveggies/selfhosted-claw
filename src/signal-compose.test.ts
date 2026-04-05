import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SignalComposeManager } from './signal-compose.js';

describe('SignalComposeManager', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a data url for QR linking', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-compose-'));
    const manager = new SignalComposeManager({
      composeDir: path.join(root, 'compose'),
      dataDir: path.join(root, 'data'),
      runner: () => ({ stdout: '', stderr: '', status: 0 }),
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(Buffer.from('png-data'), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        }),
      ),
    );

    const dataUrl = await manager.fetchLinkQrDataUrl({
      deviceName: 'Self-Hosted Claw',
      rpcUrl: 'http://127.0.0.1:8080',
    });

    expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('starts registration with the expected payload', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-compose-'));
    const manager = new SignalComposeManager({
      composeDir: path.join(root, 'compose'),
      dataDir: path.join(root, 'data'),
      runner: () => ({ stdout: '', stderr: '', status: 0 }),
    });

    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ message: 'Verification code sent' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await manager.startRegistration({
      account: '+15555550123',
      rpcUrl: 'http://127.0.0.1:8080',
      useVoice: true,
    });

    expect(result.message).toContain('Verification code sent');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        href: 'http://127.0.0.1:8080/v1/register/%2B15555550123',
      }),
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  it('verifies registration codes through the managed bridge', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-compose-'));
    const manager = new SignalComposeManager({
      composeDir: path.join(root, 'compose'),
      dataDir: path.join(root, 'data'),
      runner: () => ({ stdout: '', stderr: '', status: 0 }),
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ message: 'Registered successfully' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const result = await manager.verifyRegistration({
      account: '+15555550123',
      rpcUrl: 'http://127.0.0.1:8080',
      code: '123-456',
    });

    expect(result.message).toContain('Registered successfully');
  });
});
