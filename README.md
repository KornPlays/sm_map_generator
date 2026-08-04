# Scrap Mechanic Chapter 2 Browser Map Generator

Generate a complete Scrap Mechanic Chapter 2 world map from a world seed or a
local `.db` save file — without starting Scrap Mechanic.

**Live site:** https://sm.kornplays.com

**Source code:** https://github.com/KornPlays/sm_map_generator

The site is fully static. Map generation, save-file seed extraction, and WebP
encoding run in the visitor's browser. Nothing is sent to a server.

## Features

- Enter any signed 32-bit world seed.
- Upload a Scrap Mechanic `.db` save to fill in its seed automatically.
- Generate at 25, 50, or 100 pixels per world cell.
- Download the generated map as WebP.
- Cancel a generation in progress.
- Uses a background worker so the interface stays responsive while generating.

## Run locally

Requires Node.js `20.19` or newer.

```bash
git clone https://github.com/YOUR-USERNAME/YOUR-REPOSITORY.git
cd YOUR-REPOSITORY
npm ci
npm run dev
```

Open the local URL printed by Vite.

## Build and host it yourself

```bash
npm ci
npm run build
```

Upload the **contents** of `dist/` to any HTTPS static-file host. No Node.js
process, database, API key, WebSocket, or server-side generator is needed after
the build completes.

Examples of suitable hosts include GitHub Pages, Cloudflare Pages, Netlify,
Vercel static hosting, an S3-compatible static bucket, or a normal web server
such as Caddy or Nginx.

Your host should serve `index.html` at the site root and preserve the `assets/`,
`runtime/`, and `vendor/` folders exactly as built.

## Updating the bundled map data

This repository intentionally includes the browser assets and runtime files it
needs, so a standalone clone can build successfully. When updating the tile
library or Chapter 2 generation data, refresh these tracked folders from the
canonical generator project before rebuilding:

- `public/assets/` — captured tile images and the excavation-island image.
- `public/runtime/data/` — tile metadata and excavation-world data.
- `public/runtime/lua/` — browser-used Chapter 2 generation scripts.

Then run `npm run test:generator` and `npm run build` before publishing.
