import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { parseSmsSocketGatewayUrl } from '../src/sms-socket-gateway-url.js';

export type SmsSocketRelayAction = 'install' | 'remove' | 'status';

export interface SmsSocketRelayTarget {
  gatewayHost: string;
  gatewayPort: number;
  listenPort: number;
}

function readSmsSocketGatewayUrl(projectRoot: string = process.cwd()): string {
  const repoSettingsPath = path.join(
    projectRoot,
    'admin-config',
    'integrations',
    'sms-socket',
    'settings.json',
  );
  const legacySettingsPath = path.join(
    os.homedir(),
    '.config',
    'self-hosted-claw',
    'integrations',
    'sms-socket',
    'settings.json',
  );

  for (const candidate of [repoSettingsPath, legacySettingsPath]) {
    if (!fs.existsSync(candidate)) continue;
    const parsed = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as {
      gatewayUrl?: string;
    };
    if (parsed.gatewayUrl?.trim()) return parsed.gatewayUrl.trim();
  }
  return 'ws://127.0.0.1:8787/';
}

export function resolveSmsSocketRelayTarget(
  rawGatewayUrl: string = readSmsSocketGatewayUrl(),
  listenPort?: number,
): SmsSocketRelayTarget {
  const parsed = parseSmsSocketGatewayUrl(rawGatewayUrl);
  const envRelayPort = Number.parseInt(
    process.env.SMS_SOCKET_HOST_RELAY_PORT || '',
    10,
  );
  const fallbackPort = Number(
    parsed.port || (parsed.protocol === 'wss:' ? 443 : 80),
  );
  return {
    gatewayHost: parsed.hostname,
    gatewayPort: fallbackPort,
    listenPort: listenPort ?? (Number.isFinite(envRelayPort) ? envRelayPort : fallbackPort),
  };
}

function runNetsh(args: string[]): string {
  return execFileSync('netsh', args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

export function runSmsSocketRelayAction(
  action: SmsSocketRelayAction,
  target: SmsSocketRelayTarget = resolveSmsSocketRelayTarget(),
): void {
  if (process.platform !== 'win32') {
    throw new Error('SMS Socket relay helper currently supports Windows only');
  }

  if (action === 'status') {
    process.stdout.write(
      runNetsh(['interface', 'portproxy', 'show', 'all']),
    );
    return;
  }

  const baseDeleteArgs = [
    'interface',
    'portproxy',
    'delete',
    'v4tov4',
    `listenport=${target.listenPort}`,
    'listenaddress=0.0.0.0',
  ];

  try {
    runNetsh(baseDeleteArgs);
  } catch {
    // Ignore missing existing rule.
  }
  if (action === 'remove') return;

  const addArgs = [
    'interface',
    'portproxy',
    'add',
    'v4tov4',
    `listenport=${target.listenPort}`,
    'listenaddress=0.0.0.0',
    `connectport=${target.gatewayPort}`,
    `connectaddress=${target.gatewayHost}`,
  ];
  runNetsh(addArgs);
}

function main(): void {
  const action = process.argv[2] as SmsSocketRelayAction | undefined;
  if (action !== 'install' && action !== 'remove' && action !== 'status') {
    console.error(
      'Usage: tsx setup/sms-socket-relay.ts <install|remove|status>',
    );
    process.exit(1);
  }

  const target = resolveSmsSocketRelayTarget();
  runSmsSocketRelayAction(action, target);
  if (action === 'install') {
    console.log(
      `Installed SMS Socket relay on 0.0.0.0:${target.listenPort} -> ${target.gatewayHost}:${target.gatewayPort}`,
    );
    console.log(
      `Set SMS_SOCKET_HOST_RELAY_PORT=${target.listenPort} in .env for the Dockerized control plane.`,
    );
  } else if (action === 'remove') {
    console.log(`Removed SMS Socket relay on port ${target.listenPort}`);
  }
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(modulePath)) {
  main();
}
