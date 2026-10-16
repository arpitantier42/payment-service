# One image for every service in this repo; pick the service with the command, e.g.
#   docker run ... node src/order-service/server.js
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY db ./db
USER node
CMD ["node", "src/order-service/server.js"]
