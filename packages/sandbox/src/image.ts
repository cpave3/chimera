/** The image `chimera sandbox build` produces, and the default of a build from source. */
export const LOCAL_DEV_IMAGE = 'chimera-sandbox:dev';

/** Where release builds find the sandbox image, tagged with the release's version. */
export const RELEASE_IMAGE_REPOSITORY = 'ghcr.io/cpave3/chimera-sandbox';

const STABLE = /^v\d+\.\d+\.\d+$/;

/**
 * The image used when the user names none: a release uses the published
 * image of its own version, a build from source (`dev`) the local one.
 */
export function defaultImageRef(chimeraVersion: string): string {
  return STABLE.test(chimeraVersion)
    ? `${RELEASE_IMAGE_REPOSITORY}:${chimeraVersion}`
    : LOCAL_DEV_IMAGE;
}

/** True if `ref` is the bundled local image (eligible for auto-build). */
export function isLocalDevImage(ref: string): boolean {
  return ref === LOCAL_DEV_IMAGE;
}
