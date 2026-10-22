# Usamos Node.js sobre Debian (Bullseye) que soporta Chromium nativamente
FROM node:18-bullseye

# Instalamos Chromium y dependencias del sistema necesarias
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libgdk-pixbuf2.0-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Configuramos las variables para que Puppeteer use el Chromium del sistema
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Directorio de trabajo
WORKDIR /app

# Copiamos las dependencias
COPY package*.json ./

# Instalamos dependencias de Node
RUN npm install

# Copiamos el resto del código
COPY . .

# Puerto HTTP para Render
EXPOSE 10000

# Comando de inicio
CMD ["node", "index.js"]