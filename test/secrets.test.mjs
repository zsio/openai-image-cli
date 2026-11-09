import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { scanSource } from '../scripts/check-secrets.mjs';

test('publication scan rejects a configured credential and local env files without exposing their values', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gpt-image-secrets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secret = ['fixture', 'credential', 'not-a-real-key'].join('-');
  await writeFile(join(root, 'source.txt'), `token=${secret}`);
  await writeFile(join(root, '.env'), 'OPENAI_API_KEY=');
  const findings = await scanSource(root, secret);
  assert.deepEqual(findings.map((entry) => entry.path).sort(), ['.env', 'source.txt']);
  assert.equal(JSON.stringify(findings).includes(secret), false);
});

test('publication scan detects OpenAI key patterns and private keys while ignoring dependencies', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gpt-image-secrets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = ['sk', 'proj', 'x'.repeat(64)].join('-');
  await writeFile(join(root, 'credential.txt'), token);
  await writeFile(join(root, 'private.pem'), ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' '));
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'node_modules/ignored.txt'), token);
  const findings = await scanSource(root);
  assert.deepEqual(findings.map((entry) => entry.path).sort(), ['credential.txt', 'private.pem']);
  assert.equal(JSON.stringify(findings).includes(token), false);
});
