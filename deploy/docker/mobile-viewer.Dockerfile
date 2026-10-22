FROM node:20-bookworm-slim

WORKDIR /app/MOBILITY VIEWER
COPY MOBILITY VIEWER/package.json MOBILITY VIEWER/package-lock.json ./
RUN npm ci

WORKDIR /app
COPY MOBILITY VIEWER ./MOBILITY VIEWER
COPY scripts ./scripts

WORKDIR /app/MOBILITY VIEWER
RUN npm run build

ENV NODE_ENV=production
EXPOSE 5992
CMD ["npm", "run", "start"]
