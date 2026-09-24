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

The Docker image runs the Node server, which serves the Angular build and proxies external API and download requests.

**Prerequisites:**

- [Git](https://git-scm.com/) (only required for building from source)
- [Docker](https://www.docker.com/products/docker-desktop/)

#### Option A: Build from Source

Follow these steps to build the Docker image yourself.

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/IsAvaible/AngularModUpdater.git
    cd AngularModUpdater
    ```
2.  **Build & run the Docker container:**
    ```bash
    docker rm minecraft-mod-updater
    docker build -t minecraft-mod-updater .
    docker run --name minecraft-mod-updater -p 8080:3000 --restart unless-stopped minecraft-mod-updater
    ```

After building the image, the application will be accessible at `http://localhost:8080`. The container will be called `minecraft-mod-updater` and will restart automatically unless stopped.

## Contributors

- [@orangishcat](https://github.com/orangishcat) - Add predefined URLs to update mods from GitHub [#13](https://github.com/IsAvaible/AngularModUpdater/pull/13)
- [@swishkin](https://github.com/swishkin) - Containerize application with Docker [#14](https://github.com/IsAvaible/AngularModUpdater/pull/14)

Want to contribute? Check out the [CONTRIBUTING.md](CONTRIBUTING.md) guide.
