import { openDatabase } from '../src/database.js';
import { validateStudent } from '../src/validation.js';

const students = [
  { name: 'Анна Иванова', email: 'anna@example.com', group_name: 'ИС-21' },
  { name: 'Тимур Ахметов', email: 'timur@example.com', group_name: 'ИС-22' },
  { name: 'Мария Петрова', email: 'maria@example.com', group_name: 'ИС-21' },
];
const repository = await openDatabase();
try {
  for (const student of students) {
    const data = validateStudent(student);
    if (repository.pool) {
      await repository.pool.query(
        'INSERT INTO students (name, email, group_name) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING',
        [data.name, data.email, data.group_name],
      );
    } else {
      await repository.collection.updateOne({ email: data.email }, { $setOnInsert: data }, { upsert: true });
    }
  }
  console.log('Примеры студентов добавлены; существующие записи не изменены.');
} finally {
  await repository.close();
}
