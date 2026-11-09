#!/usr/bin/env node
import { main } from '../src/cli.mjs';
import { redact } from '../src/config.mjs';

try {
  await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`gpt-image: ${redact(error.message)}\n`);
  process.exitCode = error.exitCode || 1;
}
