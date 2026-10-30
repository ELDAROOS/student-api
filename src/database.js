import 'dotenv/config';
import { openPostgres } from './repositories/postgres.js';

export async function openDatabase() {
  const driver = process.env.DB_DRIVER ?? 'postgres';
  if (driver === 'postgres') {
    if (!process.env.DATABASE_URL) throw new Error('Задайте DATABASE_URL в .env.');
    return openPostgres(process.env.DATABASE_URL);
  }
  if (driver === 'mongodb') {
    if (!process.env.MONGODB_URI || !process.env.MONGODB_DB) throw new Error('Задайте MONGODB_URI и MONGODB_DB в .env.');
    const { openMongo } = await import('./repositories/mongodb.js');
    return openMongo(process.env.MONGODB_URI, process.env.MONGODB_DB);
  }
  throw new Error('DB_DRIVER должен быть postgres или mongodb.');
}
