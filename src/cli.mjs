import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { APIConnectionError, APIConnectionTimeoutError } from 'openai';
import { configPath, DEFAULT_MODEL, expandPath, initConfig, loadConfig, redact, safeJSON, validateBaseURL } from './config.mjs';
import { prepareInputs, requestImage } from './images.mjs';
import { chooseFormat, planOutput, reserveOutput } from './output.mjs';

const HELP = `gpt-image — 在本地调用 OpenAI Images API，每次生成一张图片

用法：
  gpt-image generate "提示词" [选项]
  gpt-image "提示词" [选项]                 与 generate 相同
  gpt-image edit "修改要求" --image 原图.png [--image 参考图.png]
  gpt-image config init                     创建空白配置文件，不覆盖已有配置
  gpt-image config path                     显示配置文件位置
  gpt-image config show                     显示配置状态，不显示 API Key

提示词与输入：
  -p, --prompt TEXT             提示词，也可以使用位置参数
      --prompt-file FILE       从 UTF-8 文件读取；- 表示标准输入
  -i, --image SOURCE           编辑输入，可重复 1–16 次；本地 PNG/JPEG/WebP、
                               HTTP(S) URL、data URL 或 OpenAI file-ID
      --mask SOURCE            PNG 蒙版，透明区域表示编辑区域
      --markup SOURCE          透明 PNG 标注层，不能与 --mask 同用
      --input-fidelity VALUE   支持该参数的编辑模型可设 high / low

官方 API 参数：
  -m, --model MODEL            默认 ${DEFAULT_MODEL}，可指定任意模型 ID
      --size SIZE              auto 或 WIDTHxHEIGHT，按模型能力决定
      --quality VALUE          auto / low / medium / high / xhigh / max
      --background VALUE       auto / opaque / transparent
      --output-format VALUE    png / jpeg / webp / gif / svg，别名 --format
      --output-compression N   JPEG/WebP 压缩质量 0–100，别名 --compression
      --moderation VALUE       auto / low
      --complexity VALUE       low / medium / high，需模型支持
      --frame-count N          GIF 帧数 2–16，需模型和项目支持
      --frame-duration-ms N    GIF 每帧间隔，至少 20 ms
      --safety-identifier ID   可选的用户安全标识
      --stream                 流式接收最终图片
      --partial-images N       流式预览数量 0–3；大于 0 自动启用 --stream
      --params JSON|@FILE      透传其他 API 请求字段，例如 SVG 嵌套参数；n 固定为 1

保存与配置：
  -o, --output FILE            指定完整输出路径，可由扩展名推断格式
  -d, --out-dir DIR            指定保存目录，不再创建带日期的子目录
      --name NAME              指定文件名，也用于默认临时目录的名称
      --config FILE            使用指定 .env 配置文件
      --base-url URL           覆盖 OPENAI_BASE_URL，默认官方 /v1 地址
      --timeout SECONDS        请求超时，默认 600 秒；不会自动重试
      --dry-run                检查参数并输出请求摘要，不联网，不创建输出文件
      --json                   成功后输出含路径、参数、用量的 JSON
  -h, --help                   帮助
  -v, --version                版本

默认保存：系统 tmp/名称-YYYYMMDD-HHmmss-SSS-随机后缀/名称.png
同时保存同名 .json 调用信息和 .prompt.txt 提示词。已有文件不会被覆盖。
stdout 默认只输出图片绝对路径；进度和错误写入 stderr。
`;

const stringOptions = [
  'prompt-file', 'mask', 'markup', 'input-fidelity', 'size', 'quality', 'background',
  'output-format', 'output-compression', 'moderation', 'complexity', 'frame-count',
  'frame-duration-ms', 'safety-identifier', 'partial-images', 'params', 'name',
  'config', 'base-url', 'timeout',
  'format', 'compression',
];

const options = {
  ...Object.fromEntries(stringOptions.map((key) => [key, { type: 'string' }])),
  prompt: { type: 'string', short: 'p' },
  model: { type: 'string', short: 'm' },
  image: { type: 'string', short: 'i', multiple: true },
  output: { type: 'string', short: 'o' },
  'out-dir': { type: 'string', short: 'd' },
  stream: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

async function readExtra(source) {
  if (source === undefined) return {};
  let extra;
  try {
    extra = JSON.parse(source.startsWith('@') ? await readFile(expandPath(source.slice(1)), 'utf8') : source);
  } catch { throw new Error('--params 需要合法的 JSON 对象，或 @文件路径。'); }
  if (!extra || Array.isArray(extra) || typeof extra !== 'object') throw new Error('--params 必须是 JSON 对象。');
  for (const field of ['prompt', 'image', 'images', 'mask', 'markup']) {
    if (Object.hasOwn(extra, field)) throw new Error(`--params 中的 ${field} 请改用对应 CLI 输入选项。`);
  }
  if (Object.hasOwn(extra, 'n') && extra.n !== 1) throw new Error('本 CLI 每次只生成一张图片，n 必须为 1。');
  return extra;
}

async function readPrompt(values, positionals) {
  const sources = Number(values.prompt !== undefined) + Number(values['prompt-file'] !== undefined) + Number(positionals.length > 0);
  if (sources !== 1) throw new Error('请使用位置参数、--prompt 或 --prompt-file 之一提供提示词。');
  let prompt = values.prompt ?? positionals.join(' ');
  if (values['prompt-file'] !== undefined) {
    if (values['prompt-file'] === '-') {
      prompt = '';
      process.stdin.setEncoding('utf8');
      for await (const chunk of process.stdin) prompt += chunk;
    } else {
      prompt = await readFile(expandPath(values['prompt-file']), 'utf8');
    }
  }
  if (!prompt.trim() || Array.from(prompt).length > 32000) throw new Error('提示词不能为空，且不能超过 32000 个字符。');
  return prompt;
}

function buildParams(values, extra, prompt, config, format, command) {
  const params = { model: config.model, ...extra, prompt, n: 1, output_format: format };
  for (const name of ['model', 'size', 'quality', 'background', 'moderation', 'complexity', 'input-fidelity', 'safety-identifier']) {
    if (values[name] !== undefined) params[name.replaceAll('-', '_')] = values[name];
  }
  for (const name of ['output-compression', 'partial-images', 'frame-count', 'frame-duration-ms']) {
    if (values[name] !== undefined) {
      if (!/^\d+$/.test(values[name])) throw new Error(`--${name} 必须是整数。`);
      params[name.replaceAll('-', '_')] = Number(values[name]);
    }
  }
  if (values.stream) params.stream = true;
  if (params.stream != null && typeof params.stream !== 'boolean') throw new Error('stream 必须是布尔值。');
  if (params.partial_images > 0) params.stream = true;
  for (const field of ['model', 'size', 'safety_identifier']) {
    if (params[field] != null && (typeof params[field] !== 'string' || !params[field].trim())) throw new Error(`${field} 必须是非空字符串。`);
  }
  if (params.size != null && params.size !== 'auto' && !/^[1-9]\d*x[1-9]\d*$/.test(params.size)) throw new Error('size 必须是 auto 或 WIDTHxHEIGHT。');
  for (const [field, allowed] of Object.entries({
    quality: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'],
    background: ['auto', 'opaque', 'transparent'],
    moderation: ['auto', 'low'],
    complexity: ['low', 'medium', 'high'],
    input_fidelity: ['low', 'high'],
  })) {
    if (params[field] != null && !allowed.includes(params[field])) throw new Error(`${field} 支持：${allowed.join(' / ')}。`);
  }
  for (const [field, min, max] of [['output_compression', 0, 100], ['partial_images', 0, 3], ['frame_count', 2, 16], ['frame_duration_ms', 20, 655350]]) {
    if (params[field] != null && (!Number.isSafeInteger(params[field]) || params[field] < min || params[field] > max)) throw new Error(`${field} 必须是 ${min}–${max} 的整数。`);
  }
  if (params.background === 'transparent' && !['png', 'webp'].includes(format)) throw new Error('透明背景请使用 PNG 或 WebP 格式。');
  if (params.output_compression != null && !['jpeg', 'webp'].includes(format)) throw new Error('output_compression 仅适用于 JPEG 和 WebP。');
  if (params.input_fidelity != null && command !== 'edit') throw new Error('input_fidelity 仅适用于 edit。');
  if ((params.frame_count != null || params.frame_duration_ms != null) && format !== 'gif') throw new Error('帧数和帧间隔仅适用于 GIF 输出。');
  if (['gif', 'svg'].includes(format) && (params.stream || params.partial_images > 0)) throw new Error('GIF / SVG 输出不支持流式生成和预览图。');
  if (format === 'gif' && values.mask) throw new Error('GIF 输出不支持蒙版。');
  return params;
}

function apiError(error, apiKey, interrupted, timedOut) {
  let message;
  if (interrupted) {
    message = '请求已取消。服务端可能已经受理，工具不会自动重新生成。';
  } else if (timedOut || error instanceof APIConnectionTimeoutError) {
    message = '请求超时。服务端可能已经受理，工具未自动重试；可用 --timeout 延长等待时间。';
  } else if (error instanceof APIConnectionError) {
    message = `连接 API 失败，请检查网络和 base URL。${error.cause?.message || ''}`;
  } else {
    message = error.error?.message || error.message;
    if (error.status) message = `HTTP ${error.status}: ${message}`;
    if (error.request_id) message += ` (request_id: ${error.request_id})`;
  }
  const safe = new Error(redact(message, apiKey));
  if (interrupted) safe.exitCode = 130;
  return safe;
}

export async function main(args) {
  const { values, positionals } = parseArgs({ args, options, allowPositionals: true });
  for (const [alias, name] of [['format', 'output-format'], ['compression', 'output-compression']]) {
    if (values[alias] !== undefined) {
      if (values[name] !== undefined && values[name] !== values[alias]) throw new Error(`--${alias} 和 --${name} 设置冲突。`);
      values[name] = values[alias];
    }
  }
  if (values.help || positionals[0] === 'help' || args.length === 0) {
    process.stdout.write(HELP);
    return;
  }
  if (values.version) {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    process.stdout.write(pkg.version + '\n');
    return;
  }
  if (positionals[0] === 'config') {
    const action = positionals[1] || 'show';
    if (positionals.length > 2) throw new Error('config 只支持 init、path 和 show。');
    const path = configPath(values.config);
    if (action === 'path') process.stdout.write(path + '\n');
    else if (action === 'init') {
      const created = await initConfig(path);
      process.stderr.write(created ? '已创建配置文件；请在本地填写 OPENAI_API_KEY。\n' : '配置文件已存在，保留原内容。\n');
      process.stdout.write(path + '\n');
    } else if (action === 'show') {
      const config = await loadConfig(values.config);
      process.stdout.write(JSON.stringify({
        config_path: config.path, config_exists: config.exists,
        api_key_configured: Boolean(config.apiKey), base_url: config.baseURL,
        model: config.model, organization: config.organization, project: config.project,
      }, null, 2) + '\n');
    } else throw new Error('config 只支持 init、path 和 show。');
    return;
  }
  let command = 'generate';
  if (['generate', 'gen', 'edit'].includes(positionals[0])) command = positionals.shift() === 'edit' ? 'edit' : 'generate';
  const prompt = await readPrompt(values, positionals);
  const config = await loadConfig(values.config);
  if (values['base-url']) {
    config.baseURL = validateBaseURL(values['base-url']);
  }
  const extra = await readExtra(values.params);
  const format = chooseFormat(values, extra);
  const params = buildParams(values, extra, prompt, config, format, command);
  const timeout = values.timeout === undefined ? 600 : Number(values.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2147483) throw new Error('--timeout 必须是 0–2147483 之间的秒数（不含 0）。');
  const inputs = await prepareInputs(values, command);
  const plan = planOutput(values, prompt, format);
  const summary = { operation: command, base_url: config.baseURL, request: { ...params, ...inputs.summary } };
  const paths = { image_path: plan.image_path, metadata_path: plan.metadata_path, prompt_path: plan.prompt_path };
  if (values['dry-run']) {
    process.stdout.write(safeJSON({ dry_run: true, ...summary, ...paths }, config.apiKey) + '\n');
    return;
  }
  if (!config.apiKey) throw new Error(`尚未配置 OPENAI_API_KEY。请在 ${config.path} 中填写（可先执行 gpt-image config init），或设置同名环境变量。`);
  const output = await reserveOutput(plan);
  const controller = new AbortController();
  let interrupted = false;
  let timedOut = false;
  const cancel = () => { interrupted = true; controller.abort(); };
  const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, timeout * 1000);
  deadline.unref();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  let received = false;
  const started = Date.now();
  try {
    process.stderr.write(`正在${command === 'edit' ? '编辑' : '生成'} 1 张图片（${params.model}）…\n`);
    const result = await requestImage(config, command, params, inputs, {
      timeout,
      signal: controller.signal,
      onPartial: async (bytes, index, outputFormat) => {
        const path = await output.partial(bytes, index, outputFormat);
        process.stderr.write(`预览图：${path}\n`);
      },
    });
    received = true;
    const metadata = {
      ...paths, ...summary, request_id: result.requestId || null,
      generated_at: new Date().toISOString(), elapsed_seconds: (Date.now() - started) / 1000,
      partial_paths: output.partialPaths, response: result.response,
    };
    const json = safeJSON(metadata, config.apiKey);
    await output.commit(result.bytes, prompt, json);
    process.stdout.write(values.json ? json + '\n' : plan.image_path + '\n');
    process.stderr.write(`已保存图片和调用信息（${metadata.elapsed_seconds.toFixed(1)} 秒）。\n`);
  } catch (error) {
    if (!received) await output.cleanup();
    else process.stderr.write(`API 已返回图片；本地保存出现问题，请检查：${plan.image_path}\n`);
    throw apiError(error, config.apiKey, interrupted, timedOut);
  } finally {
    clearTimeout(deadline);
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
