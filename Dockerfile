FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache openssh-client

COPY package*.json ./
RUN npm install --production

COPY . .

RUN mkdir -p /app/data

ENV DB_PATH=/app/data/bovedix.db

EXPOSE 3000

CMD ["node", "src/index.js"]
