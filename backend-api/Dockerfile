FROM node:20-alpine AS base

WORKDIR /app

# Install dependencies only
COPY package.json package-lock.json* ./
RUN npm ci --only=production

# Copy source
COPY . .

# Build (if needed)
RUN npm run build 2>/dev/null || true

EXPOSE 3001

CMD ["npm", "start"]
