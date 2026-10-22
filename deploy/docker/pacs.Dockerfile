FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app/PACS
COPY PACS/package.json PACS/package-lock.json ./
RUN npm ci

WORKDIR /app
COPY PACS ./PACS
COPY scripts ./scripts

WORKDIR /app/PACS
RUN npm run build

ENV NODE_ENV=production
EXPOSE 5001 5757
CMD ["node", "build/app.js"]
