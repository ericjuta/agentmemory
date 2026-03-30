# Fork note: added in this fork from upstream rohitg00/agentmemory. See NOTICE and LICENSE.
FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json tsconfig.json tsdown.config.ts iii-config.yaml iii-config.docker.yaml docker-compose.yml ./
COPY src ./src
COPY assets ./assets

RUN npm ci --legacy-peer-deps
RUN npm run build

CMD ["node", "dist/index.mjs"]
