import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

interface DockerMount {
  Type?: string;
  Source?: string;
  Destination?: string;
}

let cachedMounts: DockerMount[] | null | undefined;

function isLikelyContainerRuntime(): boolean {
  return fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');
}

function defaultInspectRunner(containerId: string): string {
  return execSync(`docker inspect ${containerId}`, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
}

export function mapContainerPathToHostPath(
  localPath: string,
  mounts: DockerMount[],
): string | null {
  const normalized = localPath.replace(/\\/g, '/');
  const matchingMount = mounts
    .filter(
      (mount) =>
        mount.Type === 'bind' &&
        typeof mount.Source === 'string' &&
        typeof mount.Destination === 'string',
    )
    .sort(
      (left, right) =>
        (right.Destination?.length ?? 0) - (left.Destination?.length ?? 0),
    )
    .find((mount) => {
      const destination = mount.Destination!.replace(/\\/g, '/');
      return (
        normalized === destination || normalized.startsWith(`${destination}/`)
      );
    });

  if (!matchingMount?.Source || !matchingMount.Destination) {
    return null;
  }

  const destination = matchingMount.Destination.replace(/\\/g, '/');
  const relativeSuffix = path.posix.relative(destination, normalized);
  if (!relativeSuffix || relativeSuffix === '.') {
    return matchingMount.Source;
  }

  const sourceLooksWindows =
    matchingMount.Source.includes('\\') ||
    /^[A-Za-z]:/.test(matchingMount.Source);
  return sourceLooksWindows
    ? path.win32.join(matchingMount.Source, relativeSuffix)
    : path.posix.join(
        matchingMount.Source,
        relativeSuffix.split(path.sep).join('/'),
      );
}

export function getContainerBindMounts(
  inspectRunner: (containerId: string) => string = defaultInspectRunner,
): DockerMount[] | null {
  if (!isLikelyContainerRuntime()) {
    return null;
  }
  if (cachedMounts !== undefined) {
    return cachedMounts;
  }

  try {
    const containerId =
      process.env.HOSTNAME?.trim() ||
      fs.readFileSync('/etc/hostname', 'utf-8').trim();
    const raw = inspectRunner(containerId);
    const parsed = JSON.parse(raw) as Array<{ Mounts?: DockerMount[] }>;
    cachedMounts = parsed[0]?.Mounts ?? null;
    return cachedMounts;
  } catch {
    cachedMounts = null;
    return cachedMounts;
  }
}

export function resolveHostPath(localPath: string): string {
  const mounts = getContainerBindMounts();
  if (!mounts) {
    return path.resolve(localPath);
  }
  return (
    mapContainerPathToHostPath(localPath, mounts) ?? path.resolve(localPath)
  );
}
