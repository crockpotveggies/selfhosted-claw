import fs from 'fs';
import net from 'net';

const DEFAULT_GATEWAY_URL = 'ws://127.0.0.1:8787/';

function isContainerRuntime(): boolean {
  return fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');
}

function isPrivateIpv4Address(hostname: string): boolean {
  if (net.isIP(hostname) !== 4) return false;
  const [a, b] = hostname.split('.').map((part) => Number(part));
  return (
    a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
  );
}

export function parseSmsSocketGatewayUrl(raw: string): URL {
  const value = raw.trim() || DEFAULT_GATEWAY_URL;
  const parsed = new URL(value);
  if (!['ws:', 'wss:'].includes(parsed.protocol)) {
    throw new Error('SMS Socket gateway URL must use ws:// or wss://');
  }
  if (!parsed.pathname) parsed.pathname = '/';
  return parsed;
}

export function resolveSmsSocketGatewayUrl(
  raw: string,
  options?: {
    inContainer?: boolean;
    relayPort?: number | null;
    relayHost?: string;
  },
): URL {
  const parsed = parseSmsSocketGatewayUrl(raw);
  const inContainer = options?.inContainer ?? isContainerRuntime();
  const configuredRelayPort =
    options?.relayPort ??
    Number.parseInt(process.env.SMS_SOCKET_HOST_RELAY_PORT || '', 10);
  const fallbackPort = Number(
    parsed.port || (parsed.protocol === 'wss:' ? 443 : 80),
  );
  const relayPort = Number.isFinite(configuredRelayPort)
    ? configuredRelayPort
    : fallbackPort;
  const relayHost = options?.relayHost || 'host.docker.internal';

  if (
    inContainer &&
    Number.isFinite(relayPort) &&
    relayPort > 0 &&
    isPrivateIpv4Address(parsed.hostname)
  ) {
    parsed.hostname = relayHost;
    parsed.port = String(relayPort);
  }

  return parsed;
}
