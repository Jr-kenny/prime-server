# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim

WORKDIR /opt/prime-server

RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

COPY provider/package.json provider/pnpm-lock.yaml ./provider/
RUN cd provider && pnpm install --frozen-lockfile --prod

COPY rpc/package.json rpc/pnpm-lock.yaml ./rpc/
RUN cd rpc && pnpm install --frozen-lockfile --prod

COPY provider ./provider
COPY rpc ./rpc
COPY scripts ./scripts

RUN groupadd --system --gid 10001 prime \
  && useradd --system --uid 10001 --gid 10001 --home-dir /opt/prime-server --shell /usr/sbin/nologin prime \
  && chown -R prime:prime /opt/prime-server

ENV NODE_ENV=production
ENV PRIME_SERVER_RPC_HOST=0.0.0.0
ENV PRIME_SERVER_RPC_PORT=8080

USER prime

EXPOSE 8080

CMD ["node", "scripts/prime-server-node.mjs"]
