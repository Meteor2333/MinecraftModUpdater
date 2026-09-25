# Package a frontend build created on the developer's machine.
FROM node:lts-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY server ./server
COPY dist/angular-mod-updater/browser ./dist/angular-mod-updater/browser

EXPOSE 3000
CMD ["node", "server/index.js"]
