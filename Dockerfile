# syntax=docker/dockerfile:1

# Stage 1: install all dependencies and compile TypeScript.
FROM node:24-bookworm-slim AS build

WORKDIR /app

# Copy dependency manifests first so Docker can cache npm install.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Stage 2: create a smaller image containing only runtime files.
FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY catalog.md ./catalog.md
COPY db/schema.sql ./db/schema.sql
COPY assets/product-images ./assets/product-images

EXPOSE 3000

CMD ["npm", "start"]
