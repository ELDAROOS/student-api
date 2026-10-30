export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const limits = { name: 100, email: 254, group_name: 50 };

export function validateStudent(body, partial = false) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Тело запроса должно быть JSON-объектом.');
  }
  const keys = Object.keys(body);
  if (!keys.length || keys.some((key) => !Object.hasOwn(limits, key))) {
    throw new HttpError(400, 'Разрешены только поля name, email, group_name; тело не должно быть пустым.');
  }
  if (!partial && Object.keys(limits).some((key) => !Object.hasOwn(body, key))) {
    throw new HttpError(400, 'Необходимо передать name, email и group_name.');
  }
  const data = {};
  for (const key of keys) {
    const value = body[key];
    if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > limits[key]) {
      throw new HttpError(400, `Поле ${key}: непустая строка длиной до ${limits[key]} символов.`);
    }
    data[key] = value.trim();
  }
  if (data.email !== undefined) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
      throw new HttpError(400, 'Некорректный email.');
    }
    data.email = data.email.toLowerCase();
  }
  return data;
}
