# Bender API container.
#
# Build from the REPOSITORY ROOT, not from this directory -- the build stage
# needs the pnpm workspace to resolve @bender/helix and @bender/tone-tools:
#
#   docker build -f apps/server/Dockerfile -t bender-api .
#
# The build stage bundles the server and the workspace packages into a single
# ESM file. The runtime stage installs only the four published runtime
# dependencies, so the pnpm workspace never has to exist inside the image.

# ---------- build ----------
FROM node:20-slim AS build

RUN corepack enable

WORKDIR /repo

# Copy only manifests first so dependency installation stays cached when
# source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json       apps/server/
COPY packages/helix/package.json    packages/helix/
COPY packages/tone-tools/package.json packages/tone-tools/

# The web app and evals are workspace members, so pnpm expects their manifests
# to exist even though this image never builds them.
COPY apps/web/package.json apps/web/
COPY evals/package.json    evals/

RUN pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig.base.json ./
COPY packages/helix       packages/helix
COPY packages/tone-tools  packages/tone-tools
COPY apps/server          apps/server

RUN pnpm --filter @bender/server build

# ---------- runtime ----------
FROM node:20-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# The bundle ships its own manifest (written by scripts/build.ts) listing only
# the published dependencies. The server's own package.json is deliberately not
# used here: it declares the @bender/* packages as `workspace:*`, which npm
# rejects with EUNSUPPORTEDPROTOCOL -- and those packages are already inlined
# into the bundle, so there is nothing to install.
COPY --from=build /repo/apps/server/dist/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force

COPY --from=build /repo/apps/server/dist ./dist

# node:20-slim provides an unprivileged `node` user. Running as root in a
# container that talks to Azure with a managed identity is needless risk.
USER node

# Matches the default in apps/server/src/config.ts.
ENV PORT=8787

# config.ts defaults HOST to 127.0.0.1, which is the right default for local
# development and completely wrong inside a container -- the process would be
# listening on the container's own loopback and nothing published through
# EXPOSE would ever reach it.
ENV HOST=0.0.0.0

EXPOSE 8787

# No credentials are baked in. Supply at deploy time:
#   AZURE_OPENAI_ENDPOINT    (required)
#   AZURE_OPENAI_DEPLOYMENT  (required)
#   AZURE_OPENAI_AUTH        entra (default) | key
#   AZURE_OPENAI_API_KEY     only when AZURE_OPENAI_AUTH=key
#   ALLOWED_ORIGINS          comma-separated browser origins, e.g. https://soricut.studio
#
# Entra is the default because key auth is disabled on the R&D resource
# (403 AuthenticationTypeDisabled). In Azure Container Apps, assign the app a
# managed identity with "Cognitive Services OpenAI User" and DefaultAzureCredential
# will pick it up with no further configuration.

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.mjs"]
