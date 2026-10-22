FROM node:20-bookworm-slim

WORKDIR /app/ECG VIEWER
COPY ECG VIEWER/package.json ECG VIEWER/package-lock.json ./
RUN npm ci --omit=dev

WORKDIR /app
COPY ECG VIEWER ./ECG VIEWER
COPY scripts ./scripts

WORKDIR /app/ECG VIEWER
ENV NODE_ENV=production
EXPOSE 7771
CMD ["node", "server.js"]
