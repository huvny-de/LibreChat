/**
 * Seed the RAG vector database with Ritual knowledge from dataset.jsonl
 *
 * Usage:
 *   node config/seed-rag.js
 *
 * Optionally override the RAG URL (e.g. if running inside Docker):
 *   RAG_SEED_URL=http://rag_api:8000 node config/seed-rag.js
 *
 * Run this once after containers are started. Re-running is safe (idempotent).
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const fs = require('fs');
const FormData = require('form-data');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET;
const RAG_PORT = process.env.RAG_PORT || 8000;
const RAG_API_URL = process.env.RAG_SEED_URL || `http://localhost:${RAG_PORT}`;
const ANON_EMAIL = process.env.ANON_USER_EMAIL;
const DATASET_PATH = path.join(__dirname, '../client/dataset.jsonl');
const TMP_FILE_PATH = path.join(__dirname, '../uploads/ritual-knowledge-base.txt');
const FILE_ID = 'ritual-knowledge-base-v1';

function generateToken(userId) {
  return jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: '10m', algorithm: 'HS256' });
}

async function main() {
  if (!MONGO_URI) throw new Error('MONGO_URI is not set');
  if (!JWT_SECRET) throw new Error('JWT_SECRET is not set');
  if (!fs.existsSync(DATASET_PATH)) throw new Error(`dataset.jsonl not found at ${DATASET_PATH}`);

  console.log(`Connecting to MongoDB...`);
  await mongoose.connect(MONGO_URI);

  const db = mongoose.connection.db;

  // Find anon user
  const user = await db.collection('users').findOne({ email: ANON_EMAIL });
  if (!user) throw new Error(`Anon user ${ANON_EMAIL} not found in DB. Run the app first.`);

  // Check if already seeded (idempotent)
  const existing = await db.collection('files').findOne({ file_id: FILE_ID });
  if (existing) {
    console.log('✅ Knowledge base already seeded. Skipping.');
    console.log(`   file_id: ${FILE_ID}`);
    await mongoose.disconnect();
    return;
  }

  // Build a single text document from all JSONL entries
  console.log('Reading dataset.jsonl...');
  const lines = fs.readFileSync(DATASET_PATH, 'utf8').trim().split('\n').filter(Boolean);
  let fullText = '# Ritual Foundation Knowledge Base\n\n';
  let docCount = 0;

  for (const line of lines) {
    try {
      const doc = JSON.parse(line);
      if (doc.url) fullText += `Source: ${doc.url}\n`;
      if (doc.title) fullText += `## ${doc.title}\n\n`;
      if (doc.text) fullText += `${doc.text}\n\n---\n\n`;
      docCount++;
    } catch {
      // skip malformed lines
    }
  }

  console.log(`Parsed ${docCount} documents.`);

  // Write to temp file for upload
  fs.mkdirSync(path.dirname(TMP_FILE_PATH), { recursive: true });
  fs.writeFileSync(TMP_FILE_PATH, fullText, 'utf8');
  const fileBytes = Buffer.byteLength(fullText, 'utf8');
  console.log(`Temp file written: ${TMP_FILE_PATH} (${(fileBytes / 1024).toFixed(1)} KB)`);

  // Wait for RAG API to be healthy (retries for up to ~90s on fresh deploy)
  console.log(`Waiting for RAG API at ${RAG_API_URL}...`);
  const MAX_RETRIES = 18;
  const RETRY_DELAY = 5000;
  let ragReady = false;
  for (let i = 1; i <= MAX_RETRIES; i++) {
    try {
      const health = await axios.get(`${RAG_API_URL}/health`, { timeout: 8000 });
      if (health.status === 200) { ragReady = true; break; }
    } catch {
      console.log(`  RAG API not ready yet (attempt ${i}/${MAX_RETRIES}), retrying in ${RETRY_DELAY / 1000}s...`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY));
    }
  }
  if (!ragReady) {
    throw new Error(`RAG API not reachable at ${RAG_API_URL} after ${MAX_RETRIES} attempts.`);
  }
  console.log('RAG API is ready.');

  // Upload to RAG API
  const jwtToken = generateToken(user._id.toString());
  const formData = new FormData();
  formData.append('file_id', FILE_ID);
  formData.append('file', fs.createReadStream(TMP_FILE_PATH), {
    filename: 'ritual-knowledge-base.txt',
    contentType: 'text/plain',
  });

  console.log('Uploading to RAG API (this may take a minute for embeddings)...');
  const response = await axios.post(`${RAG_API_URL}/embed`, formData, {
    headers: {
      Authorization: `Bearer ${jwtToken}`,
      accept: 'application/json',
      ...formData.getHeaders(),
    },
    timeout: 300000, // 5 min — HuggingFace model download on first run
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  console.log('RAG API response:', JSON.stringify(response.data));

  if (response.data.known_type === false) {
    throw new Error('RAG API rejected file type. Check the RAG API logs.');
  }
  if (response.data.status === false) {
    throw new Error(`RAG API failed to embed: ${response.data.message}`);
  }

  // Save file record to MongoDB so it appears in the LibreChat UI
  await db.collection('files').insertOne({
    user: user._id,
    file_id: FILE_ID,
    bytes: fileBytes,
    filename: 'Ritual Knowledge Base',
    filepath: 'vectordb',
    object: 'file',
    embedded: true,
    type: 'text/plain',
    source: 'vectordb',
    usage: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  console.log('\n✅ Ritual Knowledge Base seeded successfully!');
  console.log(`   Documents: ${docCount}`);
  console.log(`   Size: ${(fileBytes / 1024).toFixed(1)} KB`);
  console.log(`   file_id: ${FILE_ID}`);
  console.log('\nIn chat: attach the "Ritual Knowledge Base" file to a conversation to enable RAG.');

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('❌ Seed failed:', err.message);
  mongoose.disconnect().finally(() => process.exit(1));
});
