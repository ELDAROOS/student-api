import { readFile } from 'node:fs/promises';
import { openDatabase } from '../src/database.js';

const repository = await openDatabase();
try {
  if (repository.pool) {
    await repository.pool.query(await readFile(new URL('../sql/schema.sql', import.meta.url), 'utf8'));
  } else {
    const validator = {
      $jsonSchema: {
        bsonType: 'object',
        required: ['name', 'email', 'group_name'],
        additionalProperties: false,
        properties: {
          _id: { bsonType: 'objectId' },
          name: { bsonType: 'string', minLength: 1, maxLength: 100, pattern: '\\S' },
          email: { bsonType: 'string', maxLength: 254, pattern: '^[^\\s@A-Z]+@[^\\s@A-Z]+\\.[^\\s@A-Z]+$' },
          group_name: { bsonType: 'string', minLength: 1, maxLength: 50, pattern: '\\S' },
        },
      },
    };
    const exists = await repository.db.listCollections({ name: 'students' }).hasNext();
    if (exists) {
      await repository.db.command({ collMod: 'students', validator, validationLevel: 'strict', validationAction: 'error' });
    } else {
      await repository.db.createCollection('students', { validator });
    }
    await repository.collection.createIndex({ email: 1 }, { unique: true });
  }
  console.log('Структура students готова.');
} finally {
  await repository.close();
}
