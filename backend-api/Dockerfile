FROM node:20

WORKDIR /app

# Copy package files first - the lockfile too, so the build installs the same
# dependency versions every time instead of whatever semver resolves that day.
COPY backend-api/package.json backend-api/package-lock.json ./

RUN npm ci

# Copy backend source, database schema, and the agent install scripts that
# /api/devices/public/install-*.sh serve from <root>/endpoint-agent.
COPY backend-api/ ./
COPY database/ ./database/
COPY endpoint-agent/ ./endpoint-agent/

EXPOSE 3001

CMD ["./node_modules/.bin/tsx", "src/index.ts"]
