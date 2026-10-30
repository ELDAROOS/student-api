import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';

const root = fileURLToPath(new URL('../', import.meta.url));
const log = createWriteStream(new URL('../verification-mongodb.log', import.meta.url), { mode: 0o600 });
const resultPath = new URL('../verification-mongodb.json', import.meta.url);
const uri = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017';
const database = process.env.MONGODB_DB ?? 'student_api';
const testDatabase = process.env.MONGODB_TEST_DB ?? `${database}_test`;
assert.notEqual(testDatabase, database, 'Для тестов нужна отдельная БД.');
assert.ok(testDatabase.endsWith('_test'), 'Имя тестовой БД должно оканчиваться на _test.');
const password = uri.match(/^[^:]+:\/\/[^:]+:([^@]+)@/)?.[1];
const secrets = password ? [password, decodeURIComponent(password)] : [];
function output(chunk) {
  let message = String(chunk);
  for (const secret of secrets) message = message.replaceAll(secret, '[REDACTED]');
  process.stdout.write(message);
  log.write(message);
}
const productionEnv = { ...process.env, DB_DRIVER: 'mongodb', MONGODB_URI: uri, MONGODB_DB: database };
const testEnv = { ...productionEnv, MONGODB_DB: testDatabase, RUN_DB_TESTS: '1' };
function execute(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', output);
    child.stderr.on('data', output);
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Шаг ${args[0]} завершился с кодом ${code}.`)));
  });
}

async function checkConnection(databaseName) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    await client.db(databaseName).command({ ping: 1 });
    output(`Подключение MongoDB подтверждено: ${databaseName}.\n`);
  } finally {
    await client.close();
  }
}

async function checkConstraints() {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  let insertedId;
  try {
    await client.connect();
    const students = client.db(testDatabase).collection('students');
    const email = `schema-${randomUUID()}@example.com`;
    const inserted = await students.insertOne({ name: 'Проверка схемы', email, group_name: 'TEST' });
    insertedId = inserted.insertedId;
    await assert.rejects(students.insertOne({ name: 'Без email', group_name: 'TEST' }), { code: 121 });
    await assert.rejects(students.insertOne({ name: 'Дубль', email, group_name: 'TEST' }), { code: 11000 });
    output('JSON Schema и уникальный индекс email: PASS.\n');
  } finally {
    try {
      if (insertedId) await client.db(testDatabase).collection('students').deleteOne({ _id: insertedId });
    } finally { await client.close(); }
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
    assert.match(studentId, /^[a-f\d]{24}$/i);
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

const result = { date: new Date().toISOString(), database, testDatabase, status: 'running' };
try {
  await writeFile(resultPath, JSON.stringify(result, null, 2), { mode: 0o600 });
  await checkConnection(database);
  await checkConnection(testDatabase);
  await execute(['scripts/init-db.js'], productionEnv);
  await execute(['scripts/seed.js'], productionEnv);
  await execute(['scripts/init-db.js'], testEnv);
  await checkConstraints();
  await execute(['--test', 'test/api.test.js'], testEnv);
  await checkNetworkApi();
  result.status = 'passed';
  output('Проверка MongoDB и REST API завершена успешно. Основной режим PostgreSQL в .env сохранён.\n');
} catch (error) {
  result.status = 'failed';
  result.error = error.code ?? error.name;
  output(`Проверка остановлена: ${error.code ?? error.message}\n`);
  process.exitCode = 1;
} finally {
  await writeFile(resultPath, JSON.stringify(result, null, 2), { mode: 0o600 });
  await new Promise((resolve) => log.end(resolve));
}
