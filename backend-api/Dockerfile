FROM node:20-alpine

WORKDIR /app

# Copy package files first for better caching
COPY package.json ./

# Install ALL dependencies (including dev for tsx)
RUN npm install

# Copy source
COPY . .

EXPOSE 3001

CMD ["npx", "tsx", "src/index.ts"]
