FROM node:20-alpine
WORKDIR /app
COPY package.json .
RUN npm install --production --silent
COPY server.js .
CMD ["node", "server.js"]
