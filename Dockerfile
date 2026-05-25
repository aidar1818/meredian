# --- Build stage: компилируем native-модули (better-sqlite3) ---
FROM node:20-alpine AS build

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# --- Runtime stage ---
FROM node:20-alpine

WORKDIR /app

# tini — корректная обработка сигналов (SIGTERM при docker stop)
RUN apk add --no-cache tini

COPY --from=build /app/node_modules ./node_modules
COPY package*.json ./
COPY server.js ./
COPY db ./db
COPY middleware ./middleware
COPY routes ./routes
COPY public ./public

# Каталоги под volume (БД и загрузки)
RUN mkdir -p /app/db /app/uploads

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
