FROM node:20-bookworm-slim AS build

WORKDIR /app/RIS/frontend
COPY RIS/frontend/package.json RIS/frontend/package-lock.json ./
RUN npm ci
COPY RIS/frontend ./
RUN npm run build

FROM nginx:1.27-alpine
COPY deploy/nginx/ris.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/RIS/frontend/dist /usr/share/nginx/html
EXPOSE 80
