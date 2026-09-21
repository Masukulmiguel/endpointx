FROM node:20-alpine
WORKDIR /app
COPY backend-api/package*.json ./
RUN npm install
COPY backend-api/ .
EXPOSE 3001
CMD ["npx", "tsx", "src/index.ts"]
