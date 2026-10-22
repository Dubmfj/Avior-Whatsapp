FROM node:18-slim

WORKDIR /app

COPY package*.json ./

RUN npm install --production

COPY . .

EXPOSE 10000

CMD ["node", "index.js"]