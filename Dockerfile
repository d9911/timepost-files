FROM node:24-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY migrations ./migrations
RUN mkdir -p /data/objects && chown node:node /data/objects
USER node
EXPOSE 3050
CMD ["node", "src/server.mjs"]
