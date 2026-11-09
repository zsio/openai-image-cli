import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, mkdir, writeFile, stat, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const BIN = fileURLToPath(new URL('../bin/gpt-image.mjs', import.meta.url));
const KEY = 'sk-test-cli-fixture-no-real-credentials';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const response = () => ({ created: 1794225600, data: [{ b64_json: PNG.toString('base64') }], output_format: 'png', usage: { total_tokens: 12 } });

async function fixture(t, handler = (_, res) => res.end(JSON.stringify(response()))) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gpt-image-cli-test-')));
  const temp = join(root, 'tmp');
  await mkdir(temp);
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const call = { method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks) };
    calls.push(call);
    res.setHeader('content-type', 'application/json');
    res.setHeader('x-request-id', 'req_mock_123');
    try { await handler(call, res); } catch (error) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  function start(args, overrides = {}) {
    const env = { ...process.env };
    for (const key of ['GPT_IMAGE_CONFIG', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID', 'OPENAI_IMAGE_MODEL']) delete env[key];
    Object.assign(env, { OPENAI_API_KEY: KEY, OPENAI_BASE_URL: baseURL, XDG_CONFIG_HOME: join(root, 'config'), TMPDIR: temp }, overrides);
    for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
    const child = spawn(process.execPath, [BIN, ...args], { cwd: root, env, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => stdout += chunk);
    child.stderr.setEncoding('utf8').on('data', (chunk) => stderr += chunk);
    const done = once(child, 'close').then(([code, signal]) => ({ code, signal, stdout: stdout.trim(), stderr }));
    return { child, done };
  }
  return { root, temp, calls, baseURL, start, run: (args, env) => start(args, env).done };
}

test('config init uses private permissions, is idempotent, and show never prints a key', async (t) => {
  const f = await fixture(t);
  const first = await f.run(['config', 'init'], { OPENAI_API_KEY: undefined });
  assert.equal(first.code, 0, first.stderr);
  const path = first.stdout;
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await writeFile(path, `OPENAI_API_KEY=${KEY}\nOPENAI_IMAGE_MODEL=gpt-image-1.5\n`);
  const second = await f.run(['config', 'init']);
  assert.equal(second.code, 0);
  assert.match(await readFile(path, 'utf8'), /OPENAI_IMAGE_MODEL=gpt-image-1.5/);
  const shown = await f.run(['config', 'show'], { OPENAI_API_KEY: undefined });
  assert.equal(JSON.parse(shown.stdout).api_key_configured, true);
  assert.equal(JSON.parse(shown.stdout).model, 'gpt-image-1.5');
  assert.equal(shown.stdout.includes(KEY), false);
  assert.equal(f.calls.length, 0);
});

test('generation loads the user config from any working directory and saves one image in a dated tmp folder', async (t) => {
  const f = await fixture(t);
  const path = join(f.root, 'user.env');
  await writeFile(path, `OPENAI_API_KEY=${KEY}\nOPENAI_BASE_URL=${f.baseURL}\nOPENAI_IMAGE_MODEL=gpt-image-2.5-flare\n`);
  const result = await f.run(['generate', '一只穿围巾的小猫', '--name', '小猫', '--config', path, '--quality', 'high', '--size', '1536x864', '--json'], { OPENAI_API_KEY: undefined, OPENAI_BASE_URL: undefined });
  assert.equal(result.code, 0, result.stderr);
  const info = JSON.parse(result.stdout);
  assert.match(info.image_path, /小猫-\d{8}-\d{6}-\d{3}-[a-f0-9]{6}\/小猫\.png$/);
  assert.equal(dirname(dirname(info.image_path)), f.temp);
  assert.deepEqual(await readFile(info.image_path), PNG);
  assert.equal(await readFile(info.prompt_path, 'utf8'), '一只穿围巾的小猫\n');
  assert.deepEqual(JSON.parse(await readFile(info.metadata_path, 'utf8')), info);
  assert.equal(info.request_id, 'req_mock_123');
  assert.equal(info.response.usage.total_tokens, 12);
  assert.equal(result.stdout.includes(KEY), false);
  assert.equal(result.stdout.includes(PNG.toString('base64')), false);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].headers.authorization, `Bearer ${KEY}`);
  assert.equal(f.calls[0].path, '/v1/images/generations');
  assert.deepEqual(JSON.parse(f.calls[0].body), { model: 'gpt-image-2.5-flare', prompt: '一只穿围巾的小猫', n: 1, output_format: 'png', quality: 'high', size: '1536x864' });
});

test('explicit filename infers format, env overrides file, and nested API params pass through', async (t) => {
  const f = await fixture(t);
  const config = join(f.root, 'custom.env');
  await writeFile(config, 'OPENAI_API_KEY=sk-wrong-fixture-key\nOPENAI_IMAGE_MODEL=file-model\n');
  const result = await f.run(['generate', '封面', '-o', 'art/cover.jpg', '--compression', '85', '--params', '{"quality":"max","safety_identifier":"fixture-user"}', '--config', config], { OPENAI_IMAGE_MODEL: 'gpt-image-2.6-flare' });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, join(f.root, 'art/cover.jpg'));
  const body = JSON.parse(f.calls[0].body);
  assert.equal(body.output_format, 'jpeg');
  assert.equal(body.output_compression, 85);
  assert.equal(body.model, 'gpt-image-2.6-flare');
  assert.equal(body.quality, 'max');
  assert.equal(body.safety_identifier, 'fixture-user');
  assert.equal(f.calls[0].headers.authorization, `Bearer ${KEY}`);
  const dry = await f.run(['generate', '矢量图', '--format', 'svg', '--params', '{"svg":{"model":"author-model","reasoning":{"effort":"high"}}}', '--dry-run']);
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).request.svg.reasoning.effort, 'high');
  assert.equal(f.calls.length, 1);
});

test('local edit sends real multipart reference images and mask to the edits endpoint', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'a.png'), PNG);
  await writeFile(join(f.root, 'b.png'), PNG);
  await writeFile(join(f.root, 'mask.png'), PNG);
  const result = await f.run(['edit', '替换背景', '-i', 'a.png', '-i', 'b.png', '--mask', 'mask.png', '-d', 'edited', '--name', 'result.png', '--input-fidelity', 'high', '--model', 'gpt-image-1.5']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.calls[0].path, '/v1/images/edits');
  assert.match(f.calls[0].headers['content-type'], /multipart\/form-data; boundary=/);
  const form = await new Request('http://localhost', { method: 'POST', headers: { 'content-type': f.calls[0].headers['content-type'] }, body: f.calls[0].body }).formData();
  const images = [...form.entries()].filter(([key]) => key.startsWith('image')).map(([, value]) => value);
  assert.equal(images.length, 2);
  assert.deepEqual(Buffer.from(await images[0].arrayBuffer()), PNG);
  assert.deepEqual(Buffer.from(await form.get('mask').arrayBuffer()), PNG);
  assert.equal(form.get('n'), '1');
  assert.equal(form.get('prompt'), '替换背景');
  assert.equal(result.stdout, join(f.root, 'edited/result.png'));
});

test('remote and file-ID references use JSON edits, including a local markup converted to a data URL', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'markup.png'), PNG);
  const result = await f.run(['edit', '按标注修改', '-i', 'https://example.com/input.png', '-i', 'file-reference123', '--markup', 'markup.png', '-o', 'edit.png']);
  assert.equal(result.code, 0, result.stderr);
  const body = JSON.parse(f.calls[0].body);
  assert.equal(f.calls[0].path, '/v1/images/edits');
  assert.match(f.calls[0].headers['content-type'], /application\/json/);
  assert.deepEqual(body.images, [{ image_url: 'https://example.com/input.png' }, { file_id: 'file-reference123' }]);
  assert.equal(body.markup.image_url, `data:image/png;base64,${PNG.toString('base64')}`);
  assert.equal(body.n, 1);
  assert.equal(f.calls[0].headers.authorization, `Bearer ${KEY}`);
});

test('streaming saves partial previews and requires a completed event for the final image', async (t) => {
  const f = await fixture(t, (_, res) => {
    res.setHeader('content-type', 'text/event-stream');
    for (const type of ['image_generation.partial_image', 'image_generation.completed']) {
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, b64_json: PNG.toString('base64'), output_format: 'png', partial_image_index: 0, usage: { total_tokens: 5 } })}\n\n`);
    }
    res.end();
  });
  const result = await f.run(['generate', '山水', '--partial-images', '1', '-o', 'stream.png', '--json']);
  assert.equal(result.code, 0, result.stderr);
  const info = JSON.parse(result.stdout);
  assert.equal(info.partial_paths.length, 1);
  assert.deepEqual(await readFile(info.image_path), PNG);
  assert.deepEqual(await readFile(info.partial_paths[0]), PNG);
  assert.equal(JSON.parse(f.calls[0].body).stream, true);
});

test('a truncated stream fails and removes only its own output files', async (t) => {
  const f = await fixture(t, (_, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.end(`data: ${JSON.stringify({ type: 'image_edit.partial_image', b64_json: PNG.toString('base64'), output_format: 'png', partial_image_index: 0 })}\n\n`);
  });
  const result = await f.run(['generate', 'test', '--stream', '-o', 'failed/image.png']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /最终图片完成前中断/);
  assert.deepEqual(await readdir(join(f.root, 'failed')), []);
  assert.equal(f.calls.length, 1);
});

test('HTTP errors are redacted and never automatically retried', async (t) => {
  const f = await fixture(t, (_, res) => {
    res.writeHead(429);
    res.end(JSON.stringify({ error: { message: `invalid credential ${KEY}`, type: 'rate_limit_error' } }));
  });
  const result = await f.run(['generate', 'test', '-o', 'failed/image.png']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /HTTP 429/);
  assert.equal(result.stderr.includes(KEY), false);
  assert.match(result.stderr, /\[REDACTED\]/);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(await readdir(join(f.root, 'failed')), []);
});

test('existing files and sidecars are preserved and prevent a billable request', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'kept.json'), 'existing metadata');
  const result = await f.run(['generate', 'test', '-o', 'kept.png']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /输出文件已存在/);
  assert.equal(await readFile(join(f.root, 'kept.json'), 'utf8'), 'existing metadata');
  await assert.rejects(stat(join(f.root, 'kept.png')), { code: 'ENOENT' });
  assert.equal(f.calls.length, 0);
});

test('concurrent calls to the same output reserve it exclusively', async (t) => {
  const f = await fixture(t);
  const results = await Promise.all([f.run(['generate', 'one', '-o', 'same.png']), f.run(['generate', 'two', '-o', 'same.png'])]);
  assert.deepEqual(results.map((result) => result.code).sort(), [0, 1]);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(await readFile(join(f.root, 'same.png')), PNG);
});

test('invalid combinations fail before any API request or output directory creation', async (t) => {
  const f = await fixture(t);
  const cases = [
    ['--params', '{"n":2}'],
    ['--params', '{"stream":"true"}'],
    ['--params', '{"prompt":"hidden"}'],
    ['--params', '[]'],
    ['--format', 'jpeg', '--background', 'transparent'],
    ['--format', 'webp', '-o', 'mismatch.jpg'],
    ['--output-compression', '50'],
    ['--partial-images', '4'],
    ['--frame-count', '9'],
    ['--size', 'big'],
    ['--name', '../escape'],
    ['--name', 'x', '-o', 'x.png'],
    ['--format', 'gif', '--stream'],
    ['--timeout', 'NaN'],
    ['--unknown-option'],
  ];
  for (const args of cases) {
    const result = await f.run(['generate', 'test', ...args]);
    assert.notEqual(result.code, 0, JSON.stringify(args));
  }
  const noInput = await f.run(['edit', 'test']);
  assert.notEqual(noInput.code, 0);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await readdir(f.temp), []);
});

test('dry-run and help work without a key and do not create outputs', async (t) => {
  const f = await fixture(t);
  const result = await f.run(['generate', '草图', '--dry-run'], { OPENAI_API_KEY: undefined });
  assert.equal(result.code, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.dry_run, true);
  assert.equal(plan.request.model, 'gpt-image-2.6-flare');
  assert.equal(Object.hasOwn(plan.request, 'quality'), false);
  assert.deepEqual(await readdir(f.temp), []);
  assert.equal((await f.run(['--help'], { OPENAI_API_KEY: undefined })).code, 0);
  const missing = await f.run(['generate', 'test'], { OPENAI_API_KEY: undefined });
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /尚未配置 OPENAI_API_KEY/);
  assert.equal(f.calls.length, 0);
});

test('UTF-8 prompts from stdin retain characters even when input chunks split a character', async (t) => {
  const f = await fixture(t);
  const running = f.start(['generate', '--prompt-file', '-', '-o', 'stdin.png']);
  const bytes = Buffer.from('一只猫 🐱\n');
  running.child.stdin.write(bytes.subarray(0, 1));
  running.child.stdin.end(bytes.subarray(1));
  const result = await running.done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(f.calls[0].body).prompt, '一只猫 🐱\n');
});

test('timeout cleans reserved files and does not resubmit generation', async (t) => {
  const f = await fixture(t, () => {});
  const result = await f.run(['generate', 'test', '--timeout', '0.2', '-o', 'timeout/image.png']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /请求超时/);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(await readdir(join(f.root, 'timeout')), []);
});

test('Ctrl-C cancels the request, cleans placeholders, and exits with 130', async (t) => {
  let started;
  const requested = new Promise((resolve) => started = resolve);
  const f = await fixture(t, () => started());
  const running = f.start(['generate', 'test', '-o', 'cancel/image.png']);
  await requested;
  running.child.kill('SIGINT');
  const result = await running.done;
  assert.equal(result.code, 130, result.stderr);
  assert.match(result.stderr, /请求已取消/);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(await readdir(join(f.root, 'cancel')), []);
});

test('timeout also covers a stalled stream after response headers arrive', async (t) => {
  const f = await fixture(t, (_, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.write(`data: ${JSON.stringify({ type: 'image_generation.partial_image', b64_json: PNG.toString('base64'), partial_image_index: 0 })}\n\n`);
  });
  const result = await f.run(['generate', 'test', '--stream', '--timeout', '0.2', '-o', 'timeout-stream/image.png']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /请求超时/);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(await readdir(join(f.root, 'timeout-stream')), []);
});

test('untrusted preview metadata cannot change the output file extension or escape its directory', async (t) => {
  const f = await fixture(t, (_, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.write(`data: ${JSON.stringify({ type: 'image_generation.partial_image', b64_json: PNG.toString('base64'), partial_image_index: 0, output_format: '../../escape' })}\n\n`);
    res.end(`data: ${JSON.stringify({ type: 'image_generation.completed', b64_json: PNG.toString('base64') })}\n\n`);
  });
  const result = await f.run(['generate', 'test', '--stream', '-o', 'previews/image.png', '--json']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).partial_paths, [join(f.root, 'previews/image.partial-1.png')]);
});
