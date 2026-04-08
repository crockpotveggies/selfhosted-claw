/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import os from 'os';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe', windowsHide: true });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
      windowsHide: true,
    });
    logger.debug('Container runtime already running');
  } catch (err) {
    logger.error({ err }, 'Failed to reach container runtime');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Container runtime failed to start                      ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a container runtime. To fix:        ║',
    );
    console.error(
      '║  1. Ensure Docker is installed and running                     ║',
    );
    console.error(
      '║  2. Run: docker info                                           ║',
    );
    console.error(
      '║  3. Restart NanoClaw                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/** Kill orphaned NanoClaw containers from previous runs and remove dead ones. */
export function cleanupOrphans(): void {
  // Stop any running nanoclaw containers
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format {{.Names}}`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', windowsHide: true },
    );
    // Strip any stray quotes that Windows cmd may inject from the format string
    const orphans = output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((n) => n.replace(/['"]/g, '').trim())
      .filter(Boolean);
    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }

  // Remove any dead/exited nanoclaw containers that --rm missed (e.g. after daemon crash)
  try {
    const dead = execSync(
      `${CONTAINER_RUNTIME_BIN} ps -a --filter name=nanoclaw- --filter status=exited --filter status=dead --format {{.Names}}`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', windowsHide: true },
    );
    const deadNames = dead
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((n) => n.replace(/['"]/g, '').trim())
      .filter(Boolean);
    for (const name of deadNames) {
      try {
        execSync(`${CONTAINER_RUNTIME_BIN} rm ${name}`, { stdio: 'pipe', windowsHide: true });
      } catch {
        /* already removed */
      }
    }
    if (deadNames.length > 0) {
      logger.info(
        { count: deadNames.length, names: deadNames },
        'Removed dead containers',
      );
    }
  } catch {
    /* non-critical */
  }
}

/**
 * Kill containers that have been running longer than the given max age.
 * Uses `docker ps` with a format that includes creation time so we can
 * detect stale containers even if the Node process lost track of them.
 * @param knownContainers - names of containers currently tracked by GroupQueue (skip these)
 * @param maxAgeMs - maximum allowed container lifetime in milliseconds (default 45 min)
 */
export function reapStaleContainers(
  knownContainers: Set<string>,
  maxAgeMs: number = 45 * 60 * 1000,
): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format {{.Names}}\t{{.RunningFor}}`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', windowsHide: true },
    );
    const lines = output.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const [rawName, runningFor] = line.split('\t');
      const name = rawName?.replace(/['"]/g, '').trim();
      if (!name) continue;

      // Skip containers the queue is actively tracking
      if (knownContainers.has(name)) continue;

      // Parse Docker's "RunningFor" string (e.g. "5 minutes", "2 hours", "About an hour")
      const ageMs = parseDockerRunningFor(runningFor || '');
      if (ageMs > maxAgeMs) {
        logger.warn(
          { containerName: name, runningFor, ageMs },
          'Reaping stale zombie container',
        );
        try {
          stopContainer(name);
        } catch {
          // Force kill if stop fails
          try {
            execSync(`${CONTAINER_RUNTIME_BIN} kill ${name}`, {
              stdio: 'pipe',
              windowsHide: true,
            });
          } catch {
            /* already gone */
          }
        }
      }
    }
  } catch (err) {
    logger.debug({ err }, 'Failed to check for stale containers');
  }
}

/** Parse Docker's human-readable "RunningFor" into milliseconds. */
function parseDockerRunningFor(s: string): number {
  let ms = 0;
  // Match patterns like "2 hours", "5 minutes", "30 seconds", "About an hour"
  const hourMatch = s.match(/(\d+)\s*hour/);
  const minMatch = s.match(/(\d+)\s*minute/);
  const secMatch = s.match(/(\d+)\s*second/);

  if (hourMatch) ms += parseInt(hourMatch[1], 10) * 3600_000;
  if (minMatch) ms += parseInt(minMatch[1], 10) * 60_000;
  if (secMatch) ms += parseInt(secMatch[1], 10) * 1000;

  // "About an hour" / "About a minute"
  if (/about an? hour/i.test(s)) ms = Math.max(ms, 3600_000);
  if (/about an? minute/i.test(s)) ms = Math.max(ms, 60_000);

  return ms;
}

let reapInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start periodic reaping of zombie containers.
 * @param getKnownContainers - callback that returns names of actively-tracked containers
 * @param intervalMs - how often to check (default 5 minutes)
 * @param maxAgeMs - max container lifetime before reaping (default 45 minutes)
 */
export function startContainerReaper(
  getKnownContainers: () => Set<string>,
  intervalMs: number = 5 * 60 * 1000,
  maxAgeMs: number = 45 * 60 * 1000,
): void {
  if (reapInterval) return;
  reapInterval = setInterval(() => {
    reapStaleContainers(getKnownContainers(), maxAgeMs);
  }, intervalMs);
  // Don't keep the process alive just for the reaper
  reapInterval.unref();
  logger.info({ intervalMs, maxAgeMs }, 'Container reaper started');
}

export function stopContainerReaper(): void {
  if (reapInterval) {
    clearInterval(reapInterval);
    reapInterval = null;
  }
}
