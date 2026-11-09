import { readdir, readFile } from 'node:fs/promises';
import { relative, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';

// Report paths only. Never print a matching credential or a fragment of one.
export async function scanSource(root, apiKey = '') {
  const problems = [];
  async function visit(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (['.git', 'node_modules'].includes(entry.name) || entry.name.endsWith('.tgz')) continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isSymbolicLink()) problems.push({ path: relative(root, path), reason: 'source symlink' });
      else if (entry.isFile()) {
        const bytes = await readFile(path);
        const text = bytes.toString('utf8');
        const name = entry.name;
        let reason;
        if ((name === '.env' || name.startsWith('.env.')) && name !== '.env.example') reason = 'local env file';
        else if (apiKey && bytes.includes(Buffer.from(apiKey))) reason = 'configured credential';
        else if (/\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{40,}/.test(text)) reason = 'API credential pattern';
        else if (/^-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/m.test(text)) reason = 'private key';
        if (reason) problems.push({ path: relative(root, path), reason });
      }
    }
  }
  await visit(root);
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const config = await loadConfig();
  const problems = await scanSource(root, config.apiKey);
  if (problems.length) {
    for (const problem of problems) process.stderr.write(`${problem.path}: ${problem.reason}\n`);
    process.exitCode = 1;
  } else process.stdout.write('Source credential check passed. No credential values were printed.\n');
}
