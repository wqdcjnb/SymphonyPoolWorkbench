FROM ubuntu:24.04

ARG NODE_VERSION=24.21.0
ENV DEBIAN_FRONTEND=noninteractive PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    PYTHONIOENCODING=utf-8 WORKBENCH_PYTHON=/opt/venv/bin/python \
    WORKBENCH_BROWSER_CHANNEL=chrome WORKBENCH_PROFILE_ROOT=/profiles \
    PATH=/opt/node/bin:/opt/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils python3 python3-venv \
      xvfb xauth x11-utils openbox fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -m 1777 /tmp/.X11-unix

COPY symphony-pool-workbench/requirements.txt /tmp/requirements.txt
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt \
    && /opt/venv/bin/python -m playwright install-deps chromium \
    && /opt/venv/bin/python -m playwright install chrome \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    test "$(dpkg --print-architecture)" = amd64; \
    archive="node-v${NODE_VERSION}-linux-x64.tar.xz"; \
    curl --fail --location --retry 3 "https://nodejs.org/dist/v${NODE_VERSION}/${archive}" -o "/tmp/${archive}"; \
    curl --fail --location --retry 3 "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" -o /tmp/SHASUMS256.txt; \
    cd /tmp; grep -F "  ${archive}" SHASUMS256.txt | sha256sum --check --strict -; \
    tar -xJf "${archive}" -C /opt; \
    ln -s "/opt/node-v${NODE_VERSION}-linux-x64" /opt/node; \
    rm "/tmp/${archive}" /tmp/SHASUMS256.txt; \
    useradd --create-home --uid 10001 --shell /bin/bash workbench

RUN apt-get update && apt-get install -y --no-install-recommends xdotool \
    && rm -rf /var/lib/apt/lists/*

ARG XPRA_VERSION=6.5.4-r0-1
RUN curl --fail --location --retry 3 https://xpra.org/xpra.asc -o /usr/share/keyrings/xpra.asc \
    && printf 'Types: deb\nURIs: https://xpra.org/\nSuites: noble\nComponents: main\nSigned-By: /usr/share/keyrings/xpra.asc\n' > /etc/apt/sources.list.d/xpra.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
       xpra-server=${XPRA_VERSION} xpra-x11=${XPRA_VERSION} xpra-codecs=${XPRA_VERSION} \
       python3-gi-cairo python3-dbus dbus-x11 x11-xkb-utils libx264-164 \
    && rm -rf /var/lib/apt/lists/*

COPY symphony-pool-workbench /app/symphony-pool-workbench
COPY tools /app/tools
RUN python3 -c "from pathlib import Path; [p.write_bytes(p.read_bytes().replace(b'\r\n', b'\n')) for p in Path('/app').rglob('*.sh')]" \
    && chmod 755 /app/symphony-pool-workbench/deploy/docker/entrypoint.sh \
    && mkdir -p /profiles /public-docs /app/symphony-pool-workbench/data \
    && chown workbench:workbench /profiles /public-docs /app/symphony-pool-workbench/data

USER workbench
WORKDIR /app/symphony-pool-workbench
ENTRYPOINT ["/app/symphony-pool-workbench/deploy/docker/entrypoint.sh"]
