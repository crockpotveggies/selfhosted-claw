import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

describe('signal-cli docker compose config', () => {
  it('uses long-form bind mount syntax for host paths', () => {
    const composeFile = path.resolve(
      'scripts',
      'signal-cli',
      'docker-compose.yml',
    );
    const contents = fs.readFileSync(composeFile, 'utf-8');

    expect(contents).toContain('type: bind');
    expect(contents).toContain(
      'source: "${SIGNAL_CLI_DATA_DIR:-./signal-cli-data}"',
    );
    expect(contents).toContain(
      'source: "${SIGNAL_CLI_ENABLE_READ_RECEIPTS_SCRIPT:-./enable-read-receipts.sh}"',
    );
    expect(contents).not.toContain(
      '"${SIGNAL_CLI_ENABLE_READ_RECEIPTS_SCRIPT:-./enable-read-receipts.sh}:/enable-read-receipts.sh:ro"',
    );
  });
});
