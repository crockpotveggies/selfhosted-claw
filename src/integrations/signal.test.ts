import { describe, expect, it } from 'vitest';

import { ADMIN_DATA_DIR, DATA_DIR } from '../config.js';
import { getIntegration } from './registry.js';
import './signal.js';

describe('signal integration service config', () => {
  it('defaults managed service data into the mounted project data directory', () => {
    const signal = getIntegration('signal');

    expect(signal?.service).toBeDefined();

    const env = signal!.service!.buildEnv({});
    expect(env.SIGNAL_CLI_DATA_DIR.replace(/\\/g, '/')).toContain(
      `${DATA_DIR.replace(/\\/g, '/')}/signal-cli-managed`,
    );
  });

  it('remaps legacy admin-data defaults onto the mounted project data directory', () => {
    const signal = getIntegration('signal');

    const env = signal!.service!.buildEnv({
      dataDir: `${ADMIN_DATA_DIR}/signal-cli-managed`,
    });

    expect(env.SIGNAL_CLI_DATA_DIR.replace(/\\/g, '/')).toContain(
      `${DATA_DIR.replace(/\\/g, '/')}/signal-cli-managed`,
    );
  });
});
