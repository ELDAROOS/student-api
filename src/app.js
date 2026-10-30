import express from 'express';
import { HttpError, validateStudent } from './validation.js';

export function createApp(repository, { log = console.log, logError = console.error } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const started = Date.now();
    const timestamp = new Date(started).toISOString();
    res.on('finish', () => {
      log(`${timestamp} ${req.method} ${JSON.stringify(req.originalUrl)} ${res.statusCode} ${Date.now() - started}ms`);
    });
    next();
  });
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'Cache-Control': 'no-store',
    });
    next();
  });
  app.use(express.json({ limit: '10kb' }));

  const router = express.Router();
  router.param('id', (req, res, next, value) => {
    try {
      req.studentId = repository.parseId(value);
      next();
    } catch (error) {
      next(error);
    }
  });
  const requireStudent = (student) => {
    if (!student) throw new HttpError(404, 'Студент не найден.');
    return student;
  };
  router.get('/', async (req, res) => res.json(await repository.list()));
  router.get('/:id', async (req, res) => res.json(requireStudent(await repository.get(req.studentId))));

  // Для операций записи принимаем только JSON, а не формы или произвольные объекты.
  router.use((req, res, next) => {
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json')) {
      return next(new HttpError(415, 'Используйте Content-Type: application/json.'));
    }
    next();
  });
  router.post('/', async (req, res) => {
    const student = await repository.create(validateStudent(req.body));
    res.location(`/api/students/${student.id}`).status(201).json(student);
  });
  router.put('/:id', async (req, res) => {
    res.json(requireStudent(await repository.replace(req.studentId, validateStudent(req.body))));
  });
  router.patch('/:id', async (req, res) => {
    res.json(requireStudent(await repository.patch(req.studentId, validateStudent(req.body, true))));
  });
  router.delete('/:id', async (req, res) => {
    requireStudent(await repository.remove(req.studentId));
    res.status(204).end();
  });
  app.use('/api/students', router);
  app.use((req, res, next) => next(new HttpError(404, 'Маршрут не найден.')));

  // Четыре аргумента обязательны для распознавания middleware обработки ошибок.
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    let status = 500;
    let message = 'Внутренняя ошибка сервера.';
    if (error instanceof HttpError) {
      status = error.status;
      message = error.message;
    } else if (error.type === 'entity.parse.failed') {
      status = 400;
      message = 'Некорректный JSON.';
    } else if (error.type === 'entity.too.large') {
      status = 413;
      message = 'Размер JSON превышает 10 КБ.';
    } else if (error.status === 415) {
      status = 415;
      message = 'Неподдерживаемая кодировка тела запроса.';
    } else if (error.code === '23505' || error.code === 11000) {
      status = 409;
      message = 'Студент с таким email уже существует.';
    }
    // Не выводим SQL, документы, реквизиты подключения и stack trace клиенту.
    if (status === 500) logError('Ошибка сервера:', error.name, error.code ?? 'UNKNOWN');
    res.status(status).json({ error: message });
  });
  return app;
}
