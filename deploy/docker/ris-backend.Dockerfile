FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app/PACS
COPY PACS/package.json PACS/package-lock.json ./
RUN npm ci --omit=dev

WORKDIR /app/RIS/backend
COPY RIS/backend/package.json RIS/backend/package-lock.json ./
RUN npm ci --omit=dev

WORKDIR /app
COPY PACS ./PACS
COPY RIS/backend ./RIS/backend
COPY scripts ./scripts

WORKDIR /app/RIS/backend
ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "index.js"]
