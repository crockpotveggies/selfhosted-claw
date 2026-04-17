import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { getEnvFilePath, readEnvFile, setEnvFileValues } from './env.js';

describe('env file path resolution', () => {
  afterEach(() => {
    delete process.env.SELF_HOSTED_CLAW_ENV_FILE;
  });

  it('uses SELF_HOSTED_CLAW_ENV_FILE when provided', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-path-'));
    const envPath = path.join(tmpDir, 'mounted.env');
    process.env.SELF_HOSTED_CLAW_ENV_FILE = envPath;

    expect(getEnvFilePath()).toBe(envPath);
  });

  it('reads and writes the configured env file path', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-file-'));
    const envPath = path.join(tmpDir, 'mounted.env');
    fs.writeFileSync(envPath, 'OPENAI_MODEL="gpt-4.1"\n');
    process.env.SELF_HOSTED_CLAW_ENV_FILE = envPath;

    setEnvFileValues({
      OPENAI_MODEL: 'gpt-5.4',
      SIGNAL_RPC_URL: 'http://127.0.0.1:8073',
    });

    expect(readEnvFile(['OPENAI_MODEL', 'SIGNAL_RPC_URL'])).toEqual({
      OPENAI_MODEL: 'gpt-5.4',
      SIGNAL_RPC_URL: 'http://127.0.0.1:8073',
    });
    expect(fs.readFileSync(envPath, 'utf-8')).toContain(
      'OPENAI_MODEL="gpt-5.4"',
    );
  });

  it('falls back to direct overwrite when atomic rename is rejected', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-busy-'));
    const envPath = path.join(tmpDir, 'mounted.env');
    fs.writeFileSync(envPath, 'OPENAI_MODEL="gpt-4.1"\n');
    process.env.SELF_HOSTED_CLAW_ENV_FILE = envPath;

    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      const error = new Error('busy') as NodeJS.ErrnoException;
      error.code = 'EBUSY';
      throw error;
    });

    try {
      setEnvFileValues(
        {
          OPENAI_MODEL: 'gpt-5.4',
        },
        envPath,
      );
    } finally {
      renameSpy.mockRestore();
    }

    expect(readEnvFile(['OPENAI_MODEL'])).toEqual({
      OPENAI_MODEL: 'gpt-5.4',
    });
    expect(fs.existsSync(`${envPath}.tmp`)).toBe(false);
  });
});
