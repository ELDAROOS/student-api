// Установка и запуск локальной MongoDB на macOS по официальной инструкции MongoDB.
// Запускается пользователем в обычном Терминале: npm run setup:mongodb.
import assert from 'node:assert/strict';
import { existsSync, createWriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { MongoClient } from 'mongodb';

assert.equal(process.platform, 'darwin', 'Эта команда установки предназначена для macOS.');
const root = fileURLToPath(new URL('../', import.meta.url));
const log = createWriteStream(new URL('../setup-mongodb.log', import.meta.url), { mode: 0o600 });
const uri = 'mongodb://127.0.0.1:27017';
const env = { ...process.env, MONGODB_URI: uri, MONGODB_DB: 'student_api', MONGODB_TEST_DB: 'student_api_test' };
const resultPath = new URL('../setup-mongodb.json', import.meta.url);
const result = { date: new Date().toISOString(), status: 'running', step: 'connection' };
function output(chunk) {
  process.stdout.write(chunk);
  log.write(chunk);
}
function execute(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', output);
    child.stderr.on('data', output);
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} завершился с кодом ${code}.`)));
  });
}
async function available() {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 1000 });
  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    return true;
  } catch { return false; }
  finally { await client.close(); }
}

try {
  await writeFile(resultPath, JSON.stringify(result, null, 2), { mode: 0o600 });
  if (!(await available())) {
    const brew = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find(existsSync);
    assert.ok(brew, 'Homebrew не найден. Установите его с https://brew.sh, затем повторите команду.');
    output('Установка MongoDB Community 8.0 из официального Homebrew tap mongodb/brew.\n');
    result.step = 'tap';
    await execute(brew, ['tap', 'mongodb/brew']);
    result.step = 'formula-trust';
    // Homebrew также читает описание невариантной формулы при обработке версии @8.0.
    // Разрешаем только конкретные формулы из официального репозитория MongoDB.
    await execute(brew, ['trust', '--formula',
      'mongodb/brew/mongodb-community',
      'mongodb/brew/mongodb-community@8.0',
      'mongodb/brew/mongodb-database-tools',
    ]);
    result.step = 'install';
    // Полные канонические имена разрешают Homebrew загрузить только эти пакеты.
    // Database Tools — рекомендуемая зависимость из того же tap; mongosh находится в core.
    await execute(brew, ['install', 'mongodb/brew/mongodb-database-tools', 'mongodb/brew/mongodb-community@8.0']);
    // Восстановление после прерванной установки: пакет может быть установлен,
    // но ещё не связан с bin и без конфигурации, которую создаёт post_install.
    result.step = 'link';
    await execute(brew, ['link', 'mongodb/brew/mongodb-community@8.0']);
    result.step = 'postinstall';
    await execute(brew, ['postinstall', 'mongodb/brew/mongodb-community@8.0']);
    result.step = 'service';
    await execute(brew, ['services', 'start', 'mongodb-community@8.0']);
    const deadline = Date.now() + 30000;
    while (!(await available())) {
      if (Date.now() >= deadline) throw new Error('MongoDB не ответила за 30 секунд. Проверьте вывод brew services и журнал MongoDB.');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } else {
    output('MongoDB уже доступна на 127.0.0.1:27017; используется существующий локальный сервер.\n');
  }
  result.step = 'verification';
  await execute(process.execPath, ['scripts/verify-mongodb.js']);
  result.status = 'passed';
  result.step = 'complete';
  output('Локальная MongoDB готова. Базы: student_api и student_api_test; коллекция: students.\n');
} catch (error) {
  result.status = 'failed';
  result.error = error.code ?? error.message;
  output(`Настройка остановлена: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  await writeFile(resultPath, JSON.stringify(result, null, 2), { mode: 0o600 });
  await new Promise((resolve) => log.end(resolve));
}
