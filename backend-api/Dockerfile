FROM node:20

WORKDIR /app

# Copy package files first
COPY backend-api/package.json ./

RUN npm install

# Copy backend source and database schema
COPY backend-api/ ./
COPY database/ ./database/

EXPOSE 3001

CMD ["./node_modules/.bin/tsx", "src/index.ts"]
