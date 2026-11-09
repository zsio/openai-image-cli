import { mkdir, open, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';

export const DEFAULT_MODEL = 'gpt-image-2.6-flare';
export const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export const CONFIG_TEMPLATE = `# gpt-image 配置。填入 API Key 后保存，无需 source 此文件。
# 不要提交或分享本文件。环境变量优先于这里的配置。
OPENAI_API_KEY=

# 以下选项不填即可使用默认值。
# OPENAI_BASE_URL=https://api.openai.com/v1
# OPENAI_IMAGE_MODEL=${DEFAULT_MODEL}
# OPENAI_ORG_ID=
# OPENAI_PROJECT_ID=
`;

export function expandPath(value) {
  if (value === '~') return homedir();
  return resolve(value.startsWith('~/') ? join(homedir(), value.slice(2)) : value);
}

export function configPath(explicit, env = process.env) {
  return expandPath(explicit || env.GPT_IMAGE_CONFIG || join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'gpt-image', '.env'));
}

export async function initConfig(path) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
    await handle.writeFile(CONFIG_TEMPLATE);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  } finally {
    await handle?.close();
  }
}

export function validateBaseURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('OPENAI_BASE_URL / --base-url 必须是有效的 HTTP(S) URL。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('API base URL 必须是 HTTP(S) 地址，不能包含账号、密码、查询参数或片段。');
  }
  return value.replace(/\/+$/, '');
}

export async function loadConfig(explicit, env = process.env) {
  const path = configPath(explicit, env);
  let saved = {};
  let exists = false;
  try {
    saved = parseEnv(await readFile(path, 'utf8'));
    exists = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`无法读取配置文件：${path}（${error.code || '格式错误'}）`);
    if (explicit || env.GPT_IMAGE_CONFIG) throw new Error(`指定的配置文件不存在：${path}`);
  }
  const setting = (name) => (env[name] ?? saved[name] ?? '').trim();
  return {
    path,
    exists,
    apiKey: setting('OPENAI_API_KEY'),
    baseURL: validateBaseURL(setting('OPENAI_BASE_URL') || DEFAULT_BASE_URL),
    model: setting('OPENAI_IMAGE_MODEL') || DEFAULT_MODEL,
    organization: setting('OPENAI_ORG_ID') || undefined,
    project: setting('OPENAI_PROJECT_ID') || undefined,
  };
}

export function redact(value, apiKey = '') {
  let text = String(value);
  if (apiKey) text = text.split(apiKey).join('[REDACTED]');
  return text.replace(/\bsk-[A-Za-z0-9_-]{6,}/g, '[REDACTED]');
}

export function safeJSON(value, apiKey = '') {
  return JSON.stringify(value, (key, entry) => {
    if (/(?:api[_-]?key|authorization|secret|access[_-]?token)/i.test(key)) return '[REDACTED]';
    return typeof entry === 'string' ? redact(entry, apiKey) : entry;
  }, 2);
}
