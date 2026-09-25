# Minecraft Mod Updater

A Minecraft Java mod updater and migrator using the Modrinth & Curseforge API built with Angular and a Node.js API proxy.

## Features

Allows you to update or migrate your mods, modpacks, resource packs and shaders via simple drag and drop or file upload (.jar / .mrpack / .json / .zip).
You may select the version and loader you want to search updates for or migrate to.
Returns a list of all available version files of your mods and lets you download them.

## Screenshot

![Screenshot of the website](doc/Screenshot.jpeg)

## Usage

### Local development

Install dependencies and start both the Angular development server and API server:

```bash
npm ci
npm start
```

The frontend is available at `http://localhost:4200` and proxies API requests to the Node server at `http://localhost:3000`. Use `npm run start:api` separately when you only need the API server.

For CurseForge support, set `CURSEFORGE_API_KEY` in the API server environment.

### Self-hosting with Docker

The container runs the Node server, which serves the Angular build and proxies external API and download requests. The standard `Dockerfile` builds Angular inside Docker. To compile Angular on your own computer and deploy only the resulting image to Docker Hub, use `Dockerfile.prebuilt` with the steps below.

Bulk downloads run as asynchronous server jobs: the request returns immediately, the page polls for progress, and a unique download URL is issued when the ZIP is ready. The URL can be downloaded repeatedly for five minutes, and identical requests reuse the active or completed job during that period. Job state and archives are held by the running container and expire after five minutes; run one application instance for consistent job lookup. Downloads allow up to 500 files, with a 128 MiB per-file limit and a 512 MiB total input limit. A reverse proxy should pass `/api/` requests through without caching; bulk ZIP transfer starts only after the archive is ready.

#### Build locally, deploy the image

You need Node.js/npm and Docker on your build computer, and Docker on the server.

1. Build the frontend and package it into an image on your computer:

   ```bash
   npm ci
   npm run build
   docker build -f Dockerfile.prebuilt -t minecraft-mod-updater:1.0.0 .
   ```

2. Log in to Docker Hub, then tag and push the image. Replace `YOUR_DOCKERHUB_USERNAME` with your Docker Hub username:

   ```bash
   docker login
   docker tag minecraft-mod-updater:1.0.0 YOUR_DOCKERHUB_USERNAME/minecraft-mod-updater:1.0.0
   docker push YOUR_DOCKERHUB_USERNAME/minecraft-mod-updater:1.0.0
   ```

   If the Docker Hub repository is public, the server can pull it without logging in. For a private repository, run `docker login` on the server too.

3. On the server, pull and run the image. Replace the username and version tag with yours:

   ```bash
   docker pull YOUR_DOCKERHUB_USERNAME/minecraft-mod-updater:1.0.0
   docker run -d --name minecraft-mod-updater --restart unless-stopped -p 127.0.0.1:3000:3000 YOUR_DOCKERHUB_USERNAME/minecraft-mod-updater:1.0.0
   ```

   The service listens on `127.0.0.1:3000`; put your existing HTTPS reverse proxy (such as Caddy or Nginx) in front of that address. The built-in health check is available at `/api/health`.

For an upgrade, build and push a new version tag from your computer. Then replace the running container on the server:

```bash
docker pull YOUR_DOCKERHUB_USERNAME/minecraft-mod-updater:1.0.1
docker stop minecraft-mod-updater
docker rm minecraft-mod-updater
docker run -d --name minecraft-mod-updater --restart unless-stopped -p 127.0.0.1:3000:3000 YOUR_DOCKERHUB_USERNAME/minecraft-mod-updater:1.0.1
```

The server only downloads and runs the image; it does not need the source code, Node.js, or an Angular build toolchain. If you do not use a reverse proxy and want to expose port 8080 directly, replace `127.0.0.1:3000:3000` with `8080:3000` and allow that port through the server firewall.

## Contributors

- [@orangishcat](https://github.com/orangishcat) - Add predefined URLs to update mods from GitHub [#13](https://github.com/IsAvaible/AngularModUpdater/pull/13)
- [@swishkin](https://github.com/swishkin) - Containerize application with Docker [#14](https://github.com/IsAvaible/AngularModUpdater/pull/14)

Want to contribute? Check out the [CONTRIBUTING.md](CONTRIBUTING.md) guide.
