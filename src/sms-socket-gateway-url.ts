const DEFAULT_GATEWAY_URL = 'ws://127.0.0.1:8787/';

export function parseSmsSocketGatewayUrl(raw: string): URL {
  const value = raw.trim() || DEFAULT_GATEWAY_URL;
  const parsed = new URL(value);
  if (!['ws:', 'wss:'].includes(parsed.protocol)) {
    throw new Error('SMS Socket gateway URL must use ws:// or wss://');
  }
  if (!parsed.pathname) parsed.pathname = '/';
  return parsed;
}

/**
 * Resolve the gateway URL used by the WebSocket client.
 *
 * Historically this rewrote LAN targets to `host.docker.internal` + a
 * `SMS_SOCKET_HOST_RELAY_PORT` because Docker Desktop on Windows was thought
 * to block container→LAN traffic. That premise was wrong — Docker Desktop
 * bridges LAN access on all supported platforms, and the relay hop added
 * latency, a second failure mode (the Windows portproxy dropping), and a
 * required `netsh` install step. The resolver now passes the configured URL
 * through unchanged so the container connects directly to the phone.
 *
 * The second options argument is retained (ignored) so existing callers and
 * tests don't need to be touched simultaneously.
 */
export function resolveSmsSocketGatewayUrl(
  raw: string,
  _options?: {
    inContainer?: boolean;
    relayPort?: number | null;
    relayHost?: string;
  },
): URL {
  return parseSmsSocketGatewayUrl(raw);
}
