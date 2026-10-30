import { createApp } from './src/app.js';
import { openDatabase } from './src/database.js';

async function main() {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT должен быть от 1 до 65535.');
  const repository = await openDatabase();
  const app = createApp(repository);
  const server = app.listen(port, host, () => console.log(`API запущен: http://${host}:${port}/api/students`));
  server.on('error', async (error) => {
    console.error('Не удалось запустить HTTP-сервер:', error.code);
    await repository.close();
    process.exitCode = 1;
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => process.exit(1), 10000);
    timeout.unref();
    server.close(async () => {
      try { await repository.close(); }
      catch { process.exitCode = 1; }
      finally { clearTimeout(timeout); }
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch((error) => {
  console.error('Ошибка запуска:', error.code ?? error.name);
  console.error('Проверьте .env, доступность выбранной БД и выполните npm run db:init.');
  process.exitCode = 1;
});
