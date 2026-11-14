// Stamped by a release build: `--define __CHIMERA_VERSION__='"vX.Y.Z"'`.
declare const __CHIMERA_VERSION__: string | undefined;

const STABLE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** The version a build was stamped with, or `dev` for a build from source. */
export function stampedVersion(stamp: string | undefined): string {
  return stamp && stamp.trim() !== '' ? stamp.trim() : 'dev';
}

export const VERSION = stampedVersion(
  typeof __CHIMERA_VERSION__ === 'string' ? __CHIMERA_VERSION__ : undefined,
);

/** A stable release: `vX.Y.Z`, not `dev` and not a prerelease. */
export function isRelease(version: string = VERSION): boolean {
  return STABLE.test(version);
}

function parts(version: string): [number, number, number] | null {
  const match = STABLE.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * Order two versions: negative when `left` is older, positive when newer.
 * Components compare as numbers. Anything that is not a stable release,
 * `dev` included, is older than every release.
 */
export function compareVersions(left: string, right: string): number {
  const leftParts = parts(left);
  const rightParts = parts(right);
  if (!leftParts || !rightParts) return (leftParts ? 1 : 0) - (rightParts ? 1 : 0);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

/** `candidate` is a release newer than `current`. */
export function isNewer(candidate: string, current: string): boolean {
  return isRelease(candidate) && compareVersions(candidate, current) > 0;
}

/** What `chimera version --json` prints. */
export function versionReport(version: string = VERSION): {
  version: string;
  release: boolean;
  modApi: number[];
} {
  return { version, release: isRelease(version), modApi: [1] };
}
