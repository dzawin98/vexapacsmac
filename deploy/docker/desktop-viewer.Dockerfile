FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app/DESKTOP VIEWER
COPY DESKTOP VIEWER/package.json DESKTOP VIEWER/package-lock.json ./
RUN npm ci

WORKDIR /app
COPY DESKTOP VIEWER ./DESKTOP VIEWER
COPY scripts ./scripts
COPY tools ./tools

WORKDIR /app/DESKTOP VIEWER
RUN npm run build

ENV NODE_ENV=production
EXPOSE 5991
CMD ["npm", "run", "start"]
