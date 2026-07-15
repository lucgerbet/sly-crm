# syntax=docker/dockerfile:1

# ---- Stage 1: build the React/Vite frontend ----
FROM node:22-bookworm-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# ---- Stage 2: install backend production deps (better-sqlite3 is native) ----
FROM node:22-bookworm-slim AS backend-deps
WORKDIR /app/backend
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY backend/package.json backend/package-lock.json* ./
RUN npm install --omit=dev

# ---- Stage 3: runtime ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app/backend

COPY backend/ ./
COPY --from=backend-deps /app/backend/node_modules ./node_modules
COPY --from=frontend /app/frontend/dist ./public

ENV FRONTEND_DIST=./public
ENV DATABASE_PATH=/data/sly_crm.db
ENV PORT=3003

EXPOSE 3003
CMD ["node", "index.js"]
