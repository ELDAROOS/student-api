import pg from 'pg';
import { HttpError } from '../validation.js';

export async function openPostgres(connectionString) {
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 5000 });
  pool.on('error', () => console.error('Ошибка фонового соединения PostgreSQL.'));
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    await pool.end();
    throw error;
  }
  return {
    pool,
    parseId(value) {
      if (!/^[1-9]\d*$/.test(value) || Number(value) > 2147483647) {
        throw new HttpError(400, 'id должен быть положительным целым числом до 2147483647.');
      }
      return Number(value);
    },
    async list() {
      return (await pool.query('SELECT id, name, email, group_name FROM students ORDER BY id')).rows;
    },
    async get(id) {
      return (await pool.query('SELECT id, name, email, group_name FROM students WHERE id = $1', [id])).rows[0];
    },
    async create({ name, email, group_name }) {
      return (await pool.query(
        'INSERT INTO students (name, email, group_name) VALUES ($1, $2, $3) RETURNING id, name, email, group_name',
        [name, email, group_name],
      )).rows[0];
    },
    async replace(id, { name, email, group_name }) {
      return (await pool.query(
        'UPDATE students SET name = $1, email = $2, group_name = $3 WHERE id = $4 RETURNING id, name, email, group_name',
        [name, email, group_name, id],
      )).rows[0];
    },
    async patch(id, data) {
      // Имена колонок берутся из фиксированного списка, значения — только через параметры.
      const keys = ['name', 'email', 'group_name'].filter((key) => Object.hasOwn(data, key));
      const assignments = keys.map((key, index) => `${key} = $${index + 1}`).join(', ');
      return (await pool.query(
        `UPDATE students SET ${assignments} WHERE id = $${keys.length + 1} RETURNING id, name, email, group_name`,
        [...keys.map((key) => data[key]), id],
      )).rows[0];
    },
    async remove(id) {
      return (await pool.query('DELETE FROM students WHERE id = $1', [id])).rowCount > 0;
    },
    close: () => pool.end(),
  };
}
