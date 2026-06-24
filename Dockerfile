# syntax=docker.io/docker/dockerfile:1
FROM node:20-alpine
WORKDIR /app
RUN addgroup -S unibridge && adduser -S unibridge -G unibridge
COPY src/ ./src/
COPY package.json unibridge.example.json ./
RUN mkdir -p node_modules
USER unibridge
EXPOSE 5200
ENV UNIBRIDGE_HOST=0.0.0.0
ENTRYPOINT ["node", "src/cli.mjs"]