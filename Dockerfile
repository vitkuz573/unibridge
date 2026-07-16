FROM node:20-alpine

RUN addgroup -S unibridge && adduser -S unibridge -G unibridge

WORKDIR /app

COPY package.json ./
COPY src/ ./src/

RUN chown -R unibridge:unibridge /app

USER unibridge

EXPOSE 5200

ENTRYPOINT ["node", "src/cli.mjs"]
