import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const root = fileURLToPath(new URL('../', import.meta.url));
const log = createWriteStream(new URL('../verification-postgres.log', import.meta.url), { mode: 0o600 });
const resultPath = new URL('../verification-postgres.json', import.meta.url);
const productionUrl = new URL(process.env.DATABASE_URL);
const testUrl = new URL(process.env.DATABASE_TEST_URL ?? productionUrl.href);
if (!process.env.DATABASE_TEST_URL) testUrl.pathname = `${productionUrl.pathname}_test`;
assert.notEqual(testUrl.pathname, productionUrl.pathname, 'Для тестов нужна отдельная БД.');
assert.ok(testUrl.pathname.endsWith('_test'), 'Имя тестовой БД должно оканчиваться на _test.');
const secrets = [productionUrl.password, testUrl.password].flatMap((value) => [value, decodeURIComponent(value)]).filter(Boolean);
function output(chunk) {
  let message = String(chunk);
  for (const secret of secrets) message = message.replaceAll(secret, '[REDACTED]');
  process.stdout.write(message);
  log.write(message);
}
const productionEnv = { ...process.env, DB_DRIVER: 'postgres', DATABASE_URL: productionUrl.href };
const testEnv = { ...productionEnv, DATABASE_URL: testUrl.href, RUN_DB_TESTS: '1' };
function execute(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', output);
    child.stderr.on('data', output);
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Шаг ${args[0]} завершился с кодом ${code}.`)));
  });
}

async function checkConnection(url) {
  const client = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    const { rows } = await client.query('SELECT current_database() AS database, current_user AS username');
    output(`Подключение подтверждено: ${rows[0].database}, пользователь ${rows[0].username}.\n`);
  } finally {
    await client.end();
  }
}

async function checkNetworkApi() {
  const server = spawn(process.execPath, ['app.js'], {
    cwd: root,
    env: { ...testEnv, HOST: '127.0.0.1', PORT: '3000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', output);
  server.stderr.on('data', output);
  let studentId;
  async function call(method, path = '', body, expected = 200) {
    const response = await fetch(`http://127.0.0.1:3000/api/students${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    });
    const text = await response.text();
    assert.equal(response.status, expected, `${method} ${path}: ${text}`);
    return text ? JSON.parse(text) : null;
  }
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Сервер не запустился за 10 секунд.')), 10000);
      function ready(chunk) { if (String(chunk).includes('API запущен:')) finish(); }
      function exited(code) { finish(new Error(`Сервер завершился до запуска: ${code}. Проверьте, свободен ли порт 3000.`)); }
      function finish(error) {
        clearTimeout(timer);
        server.stdout.off('data', ready);
        server.off('exit', exited);
        server.off('error', finish);
        if (error) reject(error); else resolve();
      }
      server.stdout.on('data', ready);
      server.once('exit', exited);
      server.once('error', finish);
    });
    const student = { name: 'Проверка HTTP', email: `http-${randomUUID()}@example.com`, group_name: 'TEST-1' };
    const created = await call('POST', '', student, 201);
    studentId = created.id;
    assert.ok(Number.isInteger(studentId));
    assert.ok((await call('GET')).some((row) => row.id === studentId));
    assert.deepEqual(await call('GET', `/${studentId}`), { id: studentId, ...student });
    const patched = await call('PATCH', `/${studentId}`, { group_name: 'TEST-2' });
    assert.equal(patched.group_name, 'TEST-2');
    assert.equal(patched.name, student.name);
    const replaced = { ...student, name: 'Полное обновление HTTP', group_name: 'TEST-3' };
    assert.deepEqual(await call('PUT', `/${studentId}`, replaced), { id: studentId, ...replaced });
    await call('DELETE', `/${studentId}`, undefined, 204);
    await call('GET', `/${studentId}`, undefined, 404);
    studentId = undefined;
    output('Сетевые проверки всех шести маршрутов на порту 3000: PASS.\n');
  } finally {
    if (studentId && server.exitCode === null) {
      try { await call('DELETE', `/${studentId}`, undefined, 204); }
      catch { output('Не удалось удалить временную HTTP-запись из тестовой БД.\n'); }
    }
    if (server.exitCode === null && server.signalCode === null && server.pid) {
      const exited = once(server, 'exit');
      const timer = setTimeout(() => server.kill('SIGKILL'), 10000);
      server.kill('SIGTERM');
      try { await exited; } finally { clearTimeout(timer); }
    }
  }
}

const result = { date: new Date().toISOString(), database: productionUrl.pathname.slice(1), testDatabase: testUrl.pathname.slice(1), status: 'running' };
try {
  await writeFile(resultPath, JSON.stringify(result, null, 2), { mode: 0o600 });
  await checkConnection(productionUrl);
  await checkConnection(testUrl);
  await execute(['scripts/init-db.js'], productionEnv);
  await execute(['scripts/seed.js'], productionEnv);
  await execute(['scripts/init-db.js'], testEnv);
  await execute(['--test', 'test/api.test.js'], testEnv);
  await checkNetworkApi();
  result.status = 'passed';
  output('Проверка PostgreSQL и REST API завершена успешно. Для работы запустите npm start.\n');
} catch (error) {
  result.status = 'failed';
  result.error = error.code ?? error.name;
  output(`Проверка остановлена: ${error.code ?? error.message}\n`);
  process.exitCode = 1;
} finally {
  await writeFile(resultPath, JSON.stringify(result, null, 2), { mode: 0o600 });
  await new Promise((resolve) => log.end(resolve));
}
