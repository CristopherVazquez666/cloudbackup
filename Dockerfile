FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache openssh-client rclone

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3000

CMD ["node", "src/index.js"]
