import { MongoClient, ObjectId } from 'mongodb';
import { HttpError } from '../validation.js';

function serialize(document) {
  if (!document) return null;
  return { id: document._id.toHexString(), name: document.name, email: document.email, group_name: document.group_name };
}

export async function openMongo(uri, databaseName) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    await client.db(databaseName).command({ ping: 1 });
  } catch (error) {
    await client.close();
    throw error;
  }
  const db = client.db(databaseName);
  const collection = db.collection('students');
  const after = { returnDocument: 'after', includeResultMetadata: false };
  return {
    db,
    collection,
    parseId(value) {
      if (!/^[a-f\d]{24}$/i.test(value)) throw new HttpError(400, 'id должен содержать 24 шестнадцатеричных символа.');
      return new ObjectId(value);
    },
    async list() {
      return (await collection.find({}).sort({ _id: 1 }).toArray()).map(serialize);
    },
    async get(id) {
      return serialize(await collection.findOne({ _id: id }));
    },
    async create(data) {
      const { insertedId } = await collection.insertOne({ ...data });
      return serialize({ _id: insertedId, ...data });
    },
    async replace(id, data) {
      return serialize(await collection.findOneAndReplace({ _id: id }, data, after));
    },
    async patch(id, data) {
      return serialize(await collection.findOneAndUpdate({ _id: id }, { $set: data }, after));
    },
    async remove(id) {
      return (await collection.deleteOne({ _id: id })).deletedCount > 0;
    },
    close: () => client.close(),
  };
}
