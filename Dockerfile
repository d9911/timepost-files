FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY test ./test
RUN npm run build

FROM node:24-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist/src ./dist/src
COPY --from=build /app/dist/scripts ./dist/scripts
COPY --from=build /app/dist/public ./dist/public
COPY migrations ./migrations
RUN mkdir -p /data/objects && chown node:node /data/objects
USER node
EXPOSE 3050
CMD ["node", "dist/src/server.js"]
