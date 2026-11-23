# Comment Card — runs on Node 20+
FROM node:20-alpine

# Tools needed to build the native SQLite/bcrypt bindings
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public ./public

# SQLite database lives here; mount a volume on it in production
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data
EXPOSE 3000

CMD ["node", "server.js"]
