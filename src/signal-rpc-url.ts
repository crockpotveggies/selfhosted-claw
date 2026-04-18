import fs from 'fs';

function isContainerRuntime(): boolean {
  return fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');
}

function isHostNetworkMode(): boolean {
  // Set by docker-compose.control-plane.yml when running with
  // `network_mode: host`. In host mode the container shares the host's
  // network namespace, so "127.0.0.1" resolves to the host's loopback
  // naturally and no rewrite is needed — on Linux, "host.docker.internal"
  // wouldn't resolve at all.
  return process.env.NANOCLAW_CONTROL_PLANE_NET === 'host';
}

export function resolveSignalRpcUrl(
  rawUrl: string,
  inContainer = isContainerRuntime(),
): string {
  if (!inContainer || isHostNetworkMode()) return rawUrl;

  const parsed = new URL(rawUrl);
  if (
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === 'localhost' ||
    parsed.hostname === '::1'
  ) {
    parsed.hostname = 'host.docker.internal';
  }
  return parsed.toString();
}
