import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from './request.js';
import { createApp } from '../src/app.js';
import { HttpError } from '../src/validation.js';

// Тестовое хранилище проверяет HTTP-контракт без установленной СУБД.
function memoryRepository() {
  const rows = new Map();
  let sequence = 0;
  function save(id, data) {
    if ([...rows.values()].some((row) => row.email === data.email && row.id !== id)) {
      throw Object.assign(new Error('duplicate'), { code: '23505' });
    }
    const row = { id, ...data };
    rows.set(id, row);
    return row;
  }
  return {
    parseId(value) {
      if (!/^[1-9]\d*$/.test(value)) throw new HttpError(400, 'Некорректный id.');
      return Number(value);
    },
    async list() { return [...rows.values()]; },
    async get(id) { return rows.get(id); },
    async create(data) { return save(++sequence, data); },
    async replace(id, data) { return rows.has(id) ? save(id, data) : null; },
    async patch(id, data) { return rows.has(id) ? save(id, { ...rows.get(id), ...data }) : null; },
    async remove(id) { return rows.delete(id); },
    async close() {},
  };
}

async function checkContract(t, repository) {
  const logs = [];
  const api = request(createApp(repository, { log: (line) => logs.push(line), logError() {} }));
  const suffix = randomUUID();
  const original = { name: ' Анна Иванова ', email: `ANNA-${suffix}@EXAMPLE.COM`, group_name: 'ИС-21' };
  const ids = new Set();
  let id;
  try {
    await t.test('POST → 201, нормализация и Location', async () => {
      const response = await api.post('/api/students').send(original).expect(201);
      id = response.body.id;
      assert.ok(id);
      ids.add(id);
      assert.equal(response.body.name, original.name.trim());
      assert.equal(response.body.email, original.email.toLowerCase());
      assert.equal(response.headers.location, `/api/students/${id}`);
    });
    assert.ok(id, 'Дальнейшие проверки требуют созданного студента.');
    const path = `/api/students/${id}`;
    await t.test('GET списка и отдельного студента → 200', async () => {
      const list = await api.get('/api/students').expect(200);
      assert.ok(list.body.some((student) => student.id === id));
      const result = await api.get(path).expect(200);
      assert.equal(result.body.id, id);
    });
    await t.test('Повторный email → 409', async () => {
      await api.post('/api/students').send(original).expect(409);
    });
    await t.test('PATCH меняет только переданные поля', async () => {
      const result = await api.patch(path).send({ group_name: 'ИС-22' }).expect(200);
      assert.equal(result.body.group_name, 'ИС-22');
      assert.equal(result.body.name, original.name.trim());
      assert.equal(result.body.email, original.email.toLowerCase());
    });
    await t.test('PUT требует все поля', async () => {
      await api.put(path).send({ name: 'Тимур' }).expect(400);
    });
    await t.test('PUT полностью обновляет студента', async () => {
      const replacement = { name: 'Тимур', email: `timur-${suffix}@example.com`, group_name: 'ИС-23' };
      const result = await api.put(path).send(replacement).expect(200);
      assert.deepEqual(result.body, { id, ...replacement });
    });
    for (const [label, body] of [
      ['пустой объект', {}], ['массив', []], ['неизвестное поле', { role: 'admin' }],
      ['пустое имя', { name: '   ' }], ['null', { email: null }], ['email', { email: 'wrong' }],
      ['объект вместо строки', { name: { $ne: null } }], ['длинное имя', { name: 'a'.repeat(101) }],
    ]) {
      await t.test(`PATCH отклоняет: ${label}`, async () => {
        await api.patch(path).send(body).expect(400);
      });
    }
    await t.test('POST без обязательных полей → 400', async () => {
      await api.post('/api/students').send({ name: 'Анна' }).expect(400);
    });
    await t.test('Некорректный JSON → 400', async () => {
      await api.post('/api/students').type('json').send('{broken').expect(400);
    });
    await t.test('Лимит тела → 413', async () => {
      await api.post('/api/students').send({ name: 'a'.repeat(11000) }).expect(413);
    });
    await t.test('Неподдерживаемый Content-Type → 415', async () => {
      await api.post('/api/students').type('text').send('hello').expect(415);
    });
    await t.test('Некорректный id → 400', async () => {
      await api.get('/api/students/invalid-id').expect(400);
    });
    await t.test('DELETE → 204 без тела', async () => {
      const response = await api.delete(path).expect(204);
      ids.delete(id);
      assert.equal(response.text, '');
    });
    for (const method of ['get', 'put', 'patch', 'delete']) {
      await t.test(`${method.toUpperCase()} отсутствующего студента → 404`, async () => {
        let pending = api[method](path);
        if (method === 'put') pending = pending.send(original);
        if (method === 'patch') pending = pending.send({ name: 'Анна' });
        await pending.expect(404);
      });
    }
    await t.test('Заголовки защиты и 404 неизвестного маршрута', async () => {
      const response = await api.get('/unknown').expect(404);
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.equal(response.headers['x-powered-by'], undefined);
    });
    await t.test('Лог содержит время, метод, URL, статус и длительность', () => {
      assert.ok(logs.some((line) => /^\d{4}-\d{2}-\d{2}T.* POST "\/api\/students" 201 \d+ms$/.test(line)));
    });
  } finally {
    for (const createdId of ids) await repository.remove(repository.parseId(String(createdId)));
    await repository.close();
  }
}

test('HTTP-контракт с тестовым хранилищем', (t) => checkContract(t, memoryRepository()));

test('Ошибки базы → 500 без утечки внутренних данных', async () => {
  const repository = memoryRepository();
  repository.list = async () => { throw new Error('secret database credentials'); };
  const result = await request(createApp(repository, { log() {}, logError() {} })).get('/api/students').expect(500);
  assert.deepEqual(result.body, { error: 'Внутренняя ошибка сервера.' });
});

test('MongoDB duplicate key → 409', async () => {
  const repository = memoryRepository();
  repository.create = async () => { throw Object.assign(new Error('duplicate'), { code: 11000 }); };
  await request(createApp(repository, { log() {}, logError() {} })).post('/api/students')
    .send({ name: 'Анна', email: 'anna@example.com', group_name: 'ИС-21' }).expect(409);
});

// Запускайте только с отдельной учебной/тестовой БД; проверка создаёт и удаляет собственные записи.
test('HTTP-контракт с настоящей БД', { skip: process.env.RUN_DB_TESTS !== '1' }, async (t) => {
  const { openDatabase } = await import('../src/database.js');
  await checkContract(t, await openDatabase());
});
