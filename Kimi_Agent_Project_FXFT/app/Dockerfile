FROM node:22-alpine
WORKDIR /code
# Сборка внутри образа: бэкенд без зависимостей копируется в dist/boot.js,
# фронтенд — в dist/public/. npm install не нужен (зависимостей нет).
COPY package.json ./
COPY scripts ./scripts
COPY api ./api
COPY index.html ./
COPY src ./src
RUN node scripts/build.mjs
ENV PORT=3000
EXPOSE 3000
CMD ["node", "dist/boot.js"]
