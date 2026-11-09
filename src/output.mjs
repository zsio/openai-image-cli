import { mkdir, open, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { expandPath } from './config.mjs';

const FORMATS = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.webp': 'webp', '.gif': 'gif', '.svg': 'svg' };

export function chooseFormat(values, extra = {}) {
  const path = values.output || values.name || '';
  const ext = extname(path).toLowerCase();
  const inferred = FORMATS[ext];
  const explicit = values['output-format'] ?? extra.output_format;
  if (ext && !inferred) throw new Error(`不支持的输出扩展名：${ext}。支持 png、jpg、jpeg、webp、gif、svg。`);
  if (explicit != null && !Object.values(FORMATS).includes(explicit)) throw new Error('output_format 必须是 png、jpeg、webp、gif 或 svg。');
  if (explicit && inferred && explicit !== inferred) throw new Error('输出文件扩展名与 output_format 不一致。');
  return explicit || inferred || 'png';
}

function promptName(prompt) {
  return Array.from(prompt.normalize('NFC').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '')).slice(0, 32).join('') || 'image';
}

function timestamp(date) {
  const pad = (number, width = 2) => String(number).padStart(width, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;
}

export function planOutput(values, prompt, format, date = new Date()) {
  if (values.output && (values['out-dir'] || values.name)) throw new Error('--output 不能与 --out-dir 或 --name 同时使用。');
  const requested = values.name;
  if (requested && (basename(requested) !== requested || /[\\/:\x00-\x1f]/u.test(requested) || ['.', '..'].includes(requested) || !requested.trim())) {
    throw new Error('--name 只能是文件名，不能包含目录；目录请用 --out-dir。');
  }
  const extension = extname(requested || '');
  const stem = requested ? (extension ? requested.slice(0, -extension.length) : requested) : promptName(prompt);
  if (!stem.trim() || stem.startsWith('.')) throw new Error('图片名称不能为空，也不能以点开头。');
  let imagePath;
  if (values.output) {
    imagePath = expandPath(values.output);
    if (!extname(imagePath)) imagePath += `.${format}`;
  } else {
    const folder = values['out-dir']
      ? expandPath(values['out-dir'])
      : join(tmpdir(), `${stem}-${timestamp(date)}-${randomBytes(3).toString('hex')}`);
    imagePath = join(folder, `${stem}${extension || `.${format}`}`);
  }
  const prefix = imagePath.slice(0, -extname(imagePath).length);
  return { image_path: imagePath, metadata_path: `${prefix}.json`, prompt_path: `${prefix}.prompt.txt`, prefix, format };
}

// Reserve all final filenames before a billable request, using exclusive writes.
export async function reserveOutput(plan) {
  const handles = new Map();
  const partialPaths = [];
  await mkdir(dirname(plan.image_path), { recursive: true });
  const close = async () => {
    await Promise.allSettled([...handles.values()].map((handle) => handle.close()));
  };
  const cleanup = async () => {
    await close();
    await Promise.allSettled([...handles.keys(), ...partialPaths].map((path) => unlink(path)));
  };
  try {
    for (const path of [plan.image_path, plan.metadata_path, plan.prompt_path]) {
      handles.set(path, await open(path, 'wx', 0o600));
    }
  } catch (error) {
    await cleanup();
    if (error.code === 'EEXIST') throw new Error(`输出文件已存在，未发起生成请求。请换名称或路径：${error.path}`);
    throw error;
  }
  return {
    partialPaths,
    cleanup,
    async partial(buffer, index, format) {
      const path = `${plan.prefix}.partial-${index}.${format}`;
      const handle = await open(path, 'wx', 0o600);
      partialPaths.push(path);
      try { await handle.writeFile(buffer); } finally { await handle.close(); }
      return path;
    },
    async commit(buffer, prompt, metadataJSON) {
      try {
        await handles.get(plan.image_path).writeFile(buffer);
        await handles.get(plan.prompt_path).writeFile(prompt + '\n');
        await handles.get(plan.metadata_path).writeFile(metadataJSON + '\n');
      } finally { await close(); }
    },
  };
}
