FROM node:24.17.0-alpine3.23 AS build
WORKDIR /app
RUN npm install --global pnpm@11.16.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.build.json eslint.config.js ./
RUN pnpm install --frozen-lockfile
COPY src ./src
COPY frontend ./frontend
COPY public ./public
RUN npm run build

FROM node:24.17.0-alpine3.23
WORKDIR /app
ARG APP_VERSION=dev
ENV NODE_ENV=production APP_VERSION=$APP_VERSION
RUN npm install --global pnpm@11.16.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile && pnpm store prune
COPY --from=build /app/dist ./dist
COPY --from=build /app/frontend/dist ./public
# Static fixtures for the in-app admin OCR benchmark panel (src/ocr-benchmark.ts) -- images and ground
# truth only, no build step needed, so copied directly from the build context rather than the build stage.
COPY tests/ocr-benchmark/corpus ./tests/ocr-benchmark/corpus
RUN chown -R node:node /app
USER node
EXPOSE 8787
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
