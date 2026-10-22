FROM node:20-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-old-space-size=384

EXPOSE 10000

CMD ["node", "index.js"]