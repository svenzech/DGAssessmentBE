# 1) Basis-Image
FROM node:20-alpine

# 2) Arbeitsverzeichnis im Container
WORKDIR /app

# 3) pnpm via corepack aktivieren
RUN corepack enable

# 4) Nur die Package-Definitionen kopieren (für schnellen Install-Cache)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/brief-api/package.json packages/brief-api/package.json
COPY packages/brief-parser/package.json packages/brief-parser/package.json

# 5) Dependencies für das Monorepo installieren
#    (inkl. Dev-Dependencies, weil wir tsx im Startscript nutzen)
RUN pnpm install

# 6) Restlichen Code kopieren
COPY . .

# 7) Environment
ENV NODE_ENV=production

# 8) Default-Port inside Container
#    -> Ihre server.ts liest: PORT || BRIEF_API_PORT || 4000
#    Render setzt PORT automatisch, also kein Hardcoding nötig.
EXPOSE 4000

# 9) Start-Kommando
#    nutzt das "start"-Script aus packages/brief-api/package.json
CMD ["pnpm", "-F", "@datareus/brief-api", "start"]