# The dev-4 bench container (docs/TARGETS.md §0): today's Node image plus iproute2 for `tc netem` (the ru-net stand-in,
# collab-load.ts --netem). Built by scripts/bench/lib/server.ts as morfa-b0-dev4:1 when missing.
FROM node:22.23.2-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends iproute2 procps && rm -rf /var/lib/apt/lists/*
