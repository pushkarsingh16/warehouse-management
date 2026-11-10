FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --omit=dev --workspace @warehouse/server --include-workspace-root
COPY apps/server apps/server
USER node
CMD ["node", "apps/server/src/api.js"]
