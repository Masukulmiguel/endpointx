FROM node:20

WORKDIR /app

# Build context is repo root, so paths are relative to that
COPY backend-api/package.json ./

RUN npm install

COPY backend-api/ ./

RUN ls -la src/index.ts

EXPOSE 3001

CMD ["./node_modules/.bin/tsx", "src/index.ts"]
