# Based on a template from https://docs.docker.com/guides/angular/containerize/#step-2-configure-the-dockerfile
# =========================================
# Stage 1: Build the Application
# =========================================

ARG NODE_VERSION=lts-alpine
FROM node:${NODE_VERSION} AS builder

# Set the working directory inside the container
WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

# Copy the rest of the application source code into the container
COPY . .

# Build the application
RUN npm run build


FROM node:${NODE_VERSION} AS runner

WORKDIR /app

COPY --from=builder /app/dist/angular-mod-updater/browser ./dist/angular-mod-updater/browser
COPY server ./server
COPY --from=builder /app/node_modules ./node_modules

# Expose the Node server port
EXPOSE 3000

CMD ["node", "server/index.js"]
