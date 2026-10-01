# 24, not 20. The sources import each other as `./types.ts` and the test suite
# runs `src/` directly through Node's own type stripping, which needs 22.18+.
# One runtime for development, tests and production — a build that only the test
# suite could see is how `dist/` ended up two weeks stale.
FROM node:24-alpine

RUN addgroup -S unibridge && adduser -S unibridge -G unibridge

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build && npm prune --production

RUN chown -R unibridge:unibridge /app

USER unibridge

EXPOSE 5200

ENTRYPOINT ["node", "dist/cli.js"]
