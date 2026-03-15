/**
 * Create the Siggy agent in LibreChat with File Search (RAG) capability.
 *
 * Usage:
 *   node config/create-agent.js
 *
 * Prerequisites:
 *   1. LibreChat is running on http://localhost:3080
 *   2. seed-rag.js has been run successfully (ritual-knowledge-base-v1 exists in MongoDB)
 *
 * This script is idempotent — re-running it will reuse the existing agent.
 * After running, librechat.yaml is automatically updated with modelSpecs.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const fs = require('fs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET;
const ANON_EMAIL = process.env.ANON_USER_EMAIL;
const LIBRECHAT_URL = process.env.LIBRECHAT_URL || 'http://localhost:3080';
const FILE_ID = 'ritual-knowledge-base-v1';
const AGENT_NAME = 'Siggy';
const YAML_PATH = path.join(__dirname, '../librechat.yaml');

function generateToken(userId) {
  return jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: '10m', algorithm: 'HS256' });
}

function patchLibreChatYaml(agentId) {
  if (!fs.existsSync(YAML_PATH)) {
    console.warn(`⚠️  librechat.yaml not found at ${YAML_PATH}. Skipping auto-patch.`);
    return;
  }

  let content = fs.readFileSync(YAML_PATH, 'utf8');

  const modelSpecsBlock = `
modelSpecs:
  enforce: true
  list:
    - name: 'siggy'
      label: 'Siggy'
      default: true
      preset:
        endpoint: 'agents'
        agent_id: '${agentId}'
`;

  // If modelSpecs section already exists (not commented), update the agent_id line
  if (/^modelSpecs:/m.test(content)) {
    content = content.replace(
      /^(\s+agent_id:\s*')[^']+(')/m,
      `$1${agentId}$2`,
    );
    fs.writeFileSync(YAML_PATH, content, 'utf8');
    console.log(`\n📝 Updated existing modelSpecs in librechat.yaml with agent_id: ${agentId}`);
    return;
  }

  // Append new modelSpecs section at the end
  content = content.trimEnd() + '\n' + modelSpecsBlock;
  fs.writeFileSync(YAML_PATH, content, 'utf8');
  console.log(`\n📝 Added modelSpecs to librechat.yaml with agent_id: ${agentId}`);
}

async function main() {
  if (!MONGO_URI) throw new Error('MONGO_URI is not set in .env');
  if (!JWT_SECRET) throw new Error('JWT_SECRET is not set in .env');

  console.log('Connecting to MongoDB...');
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  // Get anon user
  const user = await db.collection('users').findOne({ email: ANON_EMAIL });
  if (!user) {
    throw new Error(
      `Anon user (${ANON_EMAIL}) not found in MongoDB. Start LibreChat first so the user is created.`,
    );
  }

  // Verify knowledge base file has been seeded
  const kbFile = await db.collection('files').findOne({ file_id: FILE_ID });
  if (!kbFile) {
    throw new Error(
      `Knowledge base not found (file_id: ${FILE_ID}).\nRun: node config/seed-rag.js`,
    );
  }
  console.log(`✓ Knowledge base file found: ${kbFile.filename}`);

  // Check if agent already exists (idempotent)
  const existingAgent = await db.collection('agents').findOne({ name: AGENT_NAME });
  if (existingAgent) {
    console.log(`\n✅ Agent "${AGENT_NAME}" already exists.`);
    console.log(`   agent_id: ${existingAgent.id}`);
    patchLibreChatYaml(existingAgent.id);
    await mongoose.disconnect();
    return;
  }

  // Verify LibreChat is reachable
  console.log(`Checking LibreChat at ${LIBRECHAT_URL}...`);
  try {
    await axios.get(`${LIBRECHAT_URL}/api/health`, { timeout: 10000 });
  } catch (err) {
    throw new Error(
      `LibreChat is not reachable at ${LIBRECHAT_URL}.\n` +
        `Make sure the LibreChat container is running: docker ps\n` +
        `Error: ${err.message}`,
    );
  }

  const jwtToken = generateToken(user._id.toString());

  const agentPayload = {
    name: AGENT_NAME,
    description: 'Ritual Foundation AI assistant with access to Ritual documentation',
    instructions: `You are Siggy, the AI assistant for Ritual Foundation. You help users understand Ritual's technology, protocol, and ecosystem.

Use the file_search tool to find accurate information from Ritual's documentation before answering questions. Always ground your answers in the actual documentation.

When explaining technical concepts (Infernet, EVM++, Resonance, Symphony, Execution Sidecars), be precise and clear. When you find relevant documentation, cite it naturally in your answers.`,
    provider: 'OpenRouter',
    model: 'openai/gpt-oss-120b:free',
    tools: ['file_search'],
    tool_resources: {
      file_search: {
        file_ids: [FILE_ID],
      },
    },
  };

  console.log(`\nCreating agent "${AGENT_NAME}"...`);
  let agent;
  try {
    const response = await axios.post(`${LIBRECHAT_URL}/api/agents`, agentPayload, {
      headers: {
        Authorization: `Bearer ${jwtToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });
    agent = response.data;
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data;
    if (status === 403) {
      throw new Error(
        `Permission denied (403) creating agent.\n` +
          `Check that agents.create is enabled in librechat.yaml under the interface section.\n` +
          `Response: ${JSON.stringify(detail)}`,
      );
    }
    throw new Error(
      `Failed to create agent (HTTP ${status}): ${err.message}\n` +
        `Response: ${JSON.stringify(detail)}`,
    );
  }

  console.log('\n✅ Siggy agent created successfully!');
  console.log(`   agent_id : ${agent.id}`);
  console.log(`   model    : ${agent.model}`);
  console.log(`   tools    : ${(agent.tools || []).join(', ')}`);

  patchLibreChatYaml(agent.id);

  console.log('\n📌 Next steps:');
  console.log('   1. Restart LibreChat to apply the updated librechat.yaml:');
  console.log('      docker restart LibreChat');
  console.log('   2. Open http://localhost:3080 — Siggy with RAG will be the default.');

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('\n❌ Failed:', err.message);
  mongoose.disconnect().finally(() => process.exit(1));
});
