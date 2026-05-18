# Multi-stage build для Studio 108 voice-sales (Fastify + ElevenLabs + Anthropic).
# Stage 1: builder — устанавливаем все зависимости, компилируем TypeScript.
FROM node:24-alpine AS builder

WORKDIR /app

# Сначала package*.json — это даёт нам кеш npm install при изменении только кода.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# Копируем исходники и собираем (tsc → dist/).
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Stage 2: runner — минимальный образ только с prod-зависимостями.
FROM node:24-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3108

# Только prod deps, без tsx/vitest/etc.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Готовый код + статика + предзагенерированные mp3.
COPY --from=builder /app/dist ./dist
COPY public ./public

# Папка для логов и mp3-кэша. На Fly.io туда монтируется persistent volume.
RUN mkdir -p ./data/tts-cache && mkdir -p ./data/call-analysis

EXPOSE 3108

# Простой healthcheck — Fly.io умеет его использовать.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:3108/health || exit 1

CMD ["node", "dist/server.js"]
