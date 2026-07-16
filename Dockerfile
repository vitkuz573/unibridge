FROM node:20-alpine

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
