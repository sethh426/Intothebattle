FROM node:24-alpine
WORKDIR /usr/src/app

RUN apk add --no-cache ffmpeg

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy source
COPY . .
RUN npm --prefix frontend/aetheris ci \
  && npm --prefix frontend/aetheris run build \
  && rm -rf frontend/aetheris/node_modules
RUN mkdir -p /usr/src/app/data \
  && chown -R node:node /usr/src/app

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
