FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src/ ./src/
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/server.js"]
