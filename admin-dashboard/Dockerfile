FROM node:20 AS build

WORKDIR /app

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
