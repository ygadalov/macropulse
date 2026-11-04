/* Сборка «динамической» версии: бэкенд — копией в dist/boot.js (зависимостей нет,
   бандлить нечего), фронтенд — в dist/public/. Платформа запускает `node dist/boot.js`. */
import { cp, mkdir, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist/public', { recursive: true });
await cp('api/server.js', 'dist/boot.js');
await cp('index.html', 'dist/public/index.html');
await cp('src', 'dist/public/src', { recursive: true });
/* 5-летняя история курсов (если снята: npm run history) — сервер прочитает в память при старте */
await cp('api/data/history.json', 'dist/history.json').catch(() => {});
console.log('build ok: dist/boot.js + dist/public/ (+ history.json, если есть)');
