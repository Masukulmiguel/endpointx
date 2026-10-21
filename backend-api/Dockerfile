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
# comes up with the subsystem reporting that the engine is not available.
#
# The wrapper matters: with a plain ENTRYPOINT, Docker APPENDS the CMD's
# arguments to the ENTRYPOINT, so the hook would run instead of the API and
# the container would exit before serving anything. `sh -c '... "$@"' --`
# runs the hook first and then execs the CMD in its place — `exec` keeps the
# API as PID 1, so signals reach it directly. The `;` (not `&&`) means the
# API starts even if the hook failed.
ENTRYPOINT ["sh", "-c", "node docker/install-engine.cjs; exec \"$@\"", "--"]

CMD ["./node_modules/.bin/tsx", "src/index.ts"]
