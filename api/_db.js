// api/_db.js
// Shared MongoDB connection helper. Reuses connection across serverless invocations.
const { MongoClient } = require("mongodb");

let cachedClient = null;
let cachedDb = null;

async function getDb() {
  if (cachedDb) return cachedDb;

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI env var is missing");

  const client = new MongoClient(uri);
  await client.connect();

  cachedClient = client;
  cachedDb = client.db("redtube"); // database name
  return cachedDb;
}

module.exports = { getDb };
