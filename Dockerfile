FROM node:18-slim

# Instalar git necesario para que Baileys descargue dependencias
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm install --production

COPY . .

EXPOSE 10000

CMD ["node", "index.js"]