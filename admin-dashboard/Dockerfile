FROM node:20 AS build

WORKDIR /app

# Build-time API origin (Render passes ARG-matching env vars during build).
# Falls back to the hardcoded default in services/api.ts when unset.
ARG VITE_API_ORIGIN
ENV VITE_API_ORIGIN=${VITE_API_ORIGIN}

# Build context is repo root
COPY admin-dashboard/package.json ./

RUN npm install

COPY admin-dashboard/ ./

RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY admin-dashboard/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
