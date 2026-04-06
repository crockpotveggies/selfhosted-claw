import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { ADMIN_DATA_DIR } from './config.js';

const LOCAL_SIGNAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const DEFAULT_RPC_URL = 'http://127.0.0.1:8080';

export interface SignalComposeStatus {
  account: string;
  localRpcUrl: string;
  composeFile: string;
  envFile: string;
  dataDir: string;
  configured: boolean;
  running: boolean;
  lastError: string;
}

interface SignalComposeRuntime {
  stdout: string;
  stderr: string;
  status: number | null;
}

interface SignalRegistrationResponse {
  message: string;
  captchaRequired?: true;
  captchaUrl?: string;
}

type ComposeRunner = (args: string[], cwd: string) => SignalComposeRuntime;

interface SignalComposeManagerOptions {
  composeDir?: string;
  dataDir?: string;
  runner?: ComposeRunner;
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
}

function defaultRunner(args: string[], cwd: string): SignalComposeRuntime {
  const result = spawnSync('docker', ['compose', ...args], {
    cwd,
    encoding: 'utf-8',
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

function parseRpcUrl(rpcUrl: string): URL {
  const value = rpcUrl.trim() || DEFAULT_RPC_URL;
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Signal RPC URL must use http or https');
  }
  if (!LOCAL_SIGNAL_HOSTS.has(parsed.hostname)) {
    throw new Error(
      'Managed Signal compose only supports localhost RPC URLs for security',
    );
  }
  if (parsed.pathname && parsed.pathname !== '/') {
    throw new Error(
      'Managed Signal compose expects SIGNAL_RPC_URL to point at the root path',
    );
  }
  return parsed;
}

function portFromRpcUrl(rpcUrl: string): string {
  const parsed = parseRpcUrl(rpcUrl);
  if (parsed.port) return parsed.port;
  return parsed.protocol === 'https:' ? '443' : '80';
}

function writeEnvFile(filePath: string, values: Record<string, string>): void {
  ensureDir(path.dirname(filePath));
  const content = Object.entries(values)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join('\n');
  fs.writeFileSync(filePath, `${content}\n`, { mode: 0o600 });
}

function parseJsonMessage(text: string): string {
  if (!text.trim()) return '';
  try {
    const parsed = JSON.parse(text) as {
      message?: string;
      error?: string;
      detail?: string;
    };
    return parsed.message || parsed.error || parsed.detail || text.trim();
  } catch {
    return text.trim();
  }
}

function readEnvValue(content: string, key: string): string {
  const line = content
    .split('\n')
    .find((item) => item.trim().startsWith(`${key}=`));
  if (!line) return '';
  const value = line.slice(line.indexOf('=') + 1).trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export class SignalComposeManager {
  readonly composeDir: string;
  readonly composeFile: string;
  readonly envFile: string;
  readonly dataDir: string;

  private readonly runner: ComposeRunner;

  constructor(options: SignalComposeManagerOptions = {}) {
    this.composeDir =
      options.composeDir ||
      path.resolve(process.cwd(), 'scripts', 'signal-cli');
    this.composeFile = path.join(this.composeDir, 'docker-compose.yml');
    this.envFile = path.join(this.composeDir, '.env');
    this.dataDir =
      options.dataDir || path.join(ADMIN_DATA_DIR, 'signal-cli-managed');
    this.runner = options.runner || defaultRunner;
  }

  getStatus(overrides?: {
    account?: string;
    rpcUrl?: string;
  }): SignalComposeStatus {
    const env = this.readManagedEnv();
    const account = overrides?.account || env.SIGNAL_ACCOUNT || '';
    const localRpcUrl =
      overrides?.rpcUrl || env.SIGNAL_RPC_URL || DEFAULT_RPC_URL;
    let running = false;
    let lastError = '';

    if (fs.existsSync(this.composeFile) && fs.existsSync(this.envFile)) {
      const result = this.runner(
        [
          '-f',
          this.composeFile,
          '--env-file',
          this.envFile,
          'ps',
          '--status',
          'running',
          '--services',
        ],
        this.composeDir,
      );
      if (result.status === 0) {
        running = result.stdout
          .split('\n')
          .map((item) => item.trim())
          .includes('signal-cli');
      } else {
        lastError = (
          result.stderr ||
          result.stdout ||
          'docker compose ps failed'
        ).trim();
      }
    }

    return {
      account,
      localRpcUrl,
      composeFile: this.composeFile,
      envFile: this.envFile,
      dataDir: this.dataDir,
      configured:
        Boolean(account) &&
        Boolean(localRpcUrl) &&
        fs.existsSync(this.composeFile) &&
        fs.existsSync(this.envFile),
      running,
      lastError,
    };
  }

  start(input: { account: string; rpcUrl: string }): SignalComposeStatus {
    const account = input.account.trim();
    if (!account) throw new Error('SIGNAL_ACCOUNT is required');
    const parsedRpcUrl = parseRpcUrl(input.rpcUrl || DEFAULT_RPC_URL);
    const rpcUrl = parsedRpcUrl.toString().replace(/\/$/, '');

    ensureDir(this.composeDir);
    ensureDir(this.dataDir);
    writeEnvFile(this.envFile, {
      SIGNAL_ACCOUNT: account,
      SIGNAL_RPC_URL: rpcUrl,
      SIGNAL_CLI_PORT: portFromRpcUrl(rpcUrl),
      SIGNAL_CLI_DATA_DIR: this.dataDir,
    });

    const result = this.runner(
      ['-f', this.composeFile, '--env-file', this.envFile, 'up', '-d'],
      this.composeDir,
    );
    if (result.status !== 0) {
      throw new Error(
        (result.stderr || result.stdout || 'docker compose up failed').trim(),
      );
    }

    return this.getStatus({ account, rpcUrl });
  }

  async fetchLinkQrDataUrl(input: {
    deviceName: string;
    rpcUrl: string;
  }): Promise<string> {
    const deviceName = input.deviceName.trim();
    if (!deviceName) throw new Error('A Signal device name is required');
    const rpcUrl = parseRpcUrl(input.rpcUrl || DEFAULT_RPC_URL)
      .toString()
      .replace(/\/$/, '');
    const url = new URL('/v1/qrcodelink', rpcUrl);
    url.searchParams.set('device_name', deviceName);

    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        parseJsonMessage(body) ||
          `Signal QR code request failed with ${response.status}`,
      );
    }
    const contentType = response.headers.get('content-type') || 'image/png';
    const body = Buffer.from(await response.arrayBuffer()).toString('base64');
    return `data:${contentType};base64,${body}`;
  }

  async listAccounts(rpcUrl: string): Promise<string[]> {
    const base = parseRpcUrl(rpcUrl || DEFAULT_RPC_URL)
      .toString()
      .replace(/\/$/, '');
    const url = new URL('/v1/accounts', base);
    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) return [];
    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload)) return [];
    return payload
      .map((item) =>
        typeof item === 'string'
          ? item
          : typeof item === 'object' && item !== null && 'number' in item
            ? String((item as { number: unknown }).number)
            : '',
      )
      .filter(Boolean);
  }

  async startRegistration(input: {
    account: string;
    rpcUrl: string;
    useVoice: boolean;
    captchaToken?: string;
  }): Promise<SignalRegistrationResponse> {
    const account = input.account.trim();
    if (!account) throw new Error('SIGNAL_ACCOUNT is required');
    const rpcUrl = parseRpcUrl(input.rpcUrl || DEFAULT_RPC_URL)
      .toString()
      .replace(/\/$/, '');
    const url = new URL(`/v1/register/${encodeURIComponent(account)}`, rpcUrl);
    const body: Record<string, unknown> = { use_voice: input.useVoice };
    if (input.captchaToken?.trim()) {
      body.captcha = input.captchaToken.trim();
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (response.status === 402 || (text && /captcha/i.test(text))) {
      return {
        message:
          parseJsonMessage(text) ||
          'Captcha required before Signal will send the verification code.',
        captchaRequired: true,
        captchaUrl: 'https://signalcaptchas.org/registration/generate.html',
      };
    }
    if (!response.ok) {
      throw new Error(
        parseJsonMessage(text) ||
          `Signal registration failed with ${response.status}`,
      );
    }
    return {
      message: parseJsonMessage(text) || 'Signal registration started.',
    };
  }

  async verifyRegistration(input: {
    account: string;
    rpcUrl: string;
    code: string;
  }): Promise<SignalRegistrationResponse> {
    const account = input.account.trim();
    const code = input.code.trim();
    if (!account) throw new Error('SIGNAL_ACCOUNT is required');
    if (!code) throw new Error('A verification code is required');
    const rpcUrl = parseRpcUrl(input.rpcUrl || DEFAULT_RPC_URL)
      .toString()
      .replace(/\/$/, '');
    const url = new URL(
      `/v1/register/${encodeURIComponent(account)}/verify/${encodeURIComponent(code)}`,
      rpcUrl,
    );
    const response = await fetch(url, {
      method: 'POST',
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        parseJsonMessage(text) ||
          `Signal verification failed with ${response.status}`,
      );
    }
    return {
      message: parseJsonMessage(text) || 'Signal registration verified.',
    };
  }

  private readManagedEnv(): Record<string, string> {
    try {
      const content = fs.readFileSync(this.envFile, 'utf-8');
      return {
        SIGNAL_ACCOUNT: readEnvValue(content, 'SIGNAL_ACCOUNT'),
        SIGNAL_RPC_URL: readEnvValue(content, 'SIGNAL_RPC_URL'),
        SIGNAL_CLI_PORT: readEnvValue(content, 'SIGNAL_CLI_PORT'),
        SIGNAL_CLI_DATA_DIR: readEnvValue(content, 'SIGNAL_CLI_DATA_DIR'),
      };
    } catch {
      return {};
    }
  }
}
