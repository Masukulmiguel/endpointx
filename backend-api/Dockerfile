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

# The boot hook provisions the external analysis engine when the operator
# configured a package for it (SEEFAST_ENGINE_PKG + SEEFAST_CLI). With
# nothing configured it is a no-op, so the service boots exactly as before.
# It never blocks the boot: a provisioning failure is logged and the API
# comes up with the subsystem reporting "not configured".
ENTRYPOINT ["node", "docker/install-engine.cjs"]

CMD ["./node_modules/.bin/tsx", "src/index.ts"]
