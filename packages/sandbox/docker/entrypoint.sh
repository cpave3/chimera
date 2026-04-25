#!/bin/sh
# Chimera sandbox container entrypoint.
#
# Modes:
#   bind      → no overlay; just exec sleep infinity.
#   overlay   → mount overlayfs (lowerdir=/lower, upperdir=/upper/data,
#               workdir=/upper/work) onto /workspace, then sleep.
#   ephemeral → identical to overlay; the host bypasses /upper persistence
#               by mounting it as tmpfs on docker run.
#
# Selection is via the CHIMERA_MODE env var.

set -e

mode="${CHIMERA_MODE:-bind}"

case "$mode" in
  bind)
    ;;
  overlay|ephemeral)
    mkdir -p /upper/data /upper/work /workspace
    if ! mount -t overlay overlay \
        -o "lowerdir=/lower,upperdir=/upper/data,workdir=/upper/work" \
        /workspace; then
      echo "chimera: overlay mount failed (need CAP_SYS_ADMIN)" >&2
      exit 78
    fi
    ;;
  *)
    echo "chimera: unknown CHIMERA_MODE='$mode'" >&2
    exit 64
    ;;
esac

exec sleep infinity
