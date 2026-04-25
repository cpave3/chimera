FROM debian:stable-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    python3 \
    build-essential \
    ripgrep \
    jq \
    fd-find \
    rsync \
  && rm -rf /var/lib/apt/lists/*

# Node 20 from Nodesource keyring (avoids Debian's older default).
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

# fd-find ships the binary as `fdfind` on Debian; symlink to `fd` for parity.
RUN ln -s /usr/bin/fdfind /usr/local/bin/fd

WORKDIR /workspace

COPY entrypoint.sh /usr/local/bin/chimera-entrypoint
RUN chmod +x /usr/local/bin/chimera-entrypoint

ENTRYPOINT ["/usr/local/bin/chimera-entrypoint"]
