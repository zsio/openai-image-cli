import OpenAI, { toFile } from 'openai';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { expandPath } from './config.mjs';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

async function inputImage(source, role) {
  if (/^file-[\w-]+$/.test(source)) return { reference: { file_id: source }, source };
  if (/^https?:\/\//i.test(source) || /^data:image\//i.test(source)) {
    return { reference: { image_url: source }, source: source.startsWith('data:') ? '[data URL]' : source };
  }
  const path = expandPath(source);
  const type = MIME[extname(path).toLowerCase()];
  if (!type || (role !== 'image' && type !== 'image/png')) throw new Error(`${role} 的本地文件格式不支持：${path}。参考图支持 PNG/JPEG/WebP，蒙版和标注层使用 PNG。`);
  let info;
  try { info = await stat(path); } catch { throw new Error(`输入文件不存在或不可读：${path}`); }
  const limit = role === 'mask' ? 4 * 1024 * 1024 : 50 * 1024 * 1024;
  if (!info.isFile() || info.size === 0 || info.size >= limit) throw new Error(`输入必须是非空文件且小于 ${limit / 1024 / 1024} MB：${path}`);
  const bytes = await readFile(path);
  return { bytes, type, source: path, filename: basename(path) };
}

export async function prepareInputs(values, command) {
  const sources = values.image || [];
  if (command === 'generate') {
    if (sources.length || values.mask || values.markup || values['input-fidelity']) throw new Error('参考图、蒙版、标注层和 input_fidelity 请使用 edit 子命令。');
    return { body: {}, summary: {}, json: false };
  }
  if (sources.length < 1 || sources.length > 16) throw new Error('edit 需要 1–16 个 --image，多个参考图请重复使用 --image。');
  if (values.mask && values.markup) throw new Error('--mask 和 --markup 不能同时使用。');
  const images = await Promise.all(sources.map((source) => inputImage(source, 'image')));
  const mask = values.mask ? await inputImage(values.mask, 'mask') : undefined;
  const markup = values.markup ? await inputImage(values.markup, 'markup') : undefined;
  const json = [...images, mask, markup].some((image) => image?.reference);
  const convert = (image) => json
    ? image.reference || { image_url: `data:${image.type};base64,${image.bytes.toString('base64')}` }
    : toFile(image.bytes, image.filename, { type: image.type });
  const body = { [json ? 'images' : 'image']: await Promise.all(images.map(convert)) };
  if (mask) body.mask = await convert(mask);
  if (markup) body.markup = await convert(markup);
  return {
    body,
    json,
    summary: {
      images: images.map((image) => image.source),
      ...(mask && { mask: mask.source }),
      ...(markup && { markup: markup.source }),
    },
  };
}

export function decodeImage(base64) {
  if (typeof base64 !== 'string' || !base64.trim() || !/^[A-Za-z0-9+/\s]*={0,2}$/.test(base64)) throw new Error('API 返回了空或无效的 Base64 图片。');
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length) throw new Error('API 返回了空图片。');
  return bytes;
}

export async function requestImage(config, command, params, inputs, { timeout, signal, onPartial }) {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    organization: config.organization,
    project: config.project,
    maxRetries: 0,
    timeout: timeout * 1000,
    logLevel: 'off',
  });
  const body = { ...params, ...inputs.body };
  const options = { signal };
  const pending = command === 'generate'
    ? client.images.generate(body, options)
    : inputs.json
      ? client.post('/images/edits', { body, stream: Boolean(body.stream), ...options })
      : client.images.edit(body, options);
  const { data, request_id: requestId } = await pending.withResponse();
  if (!params.stream) {
    if (!Array.isArray(data.data) || data.data.length !== 1) throw new Error('API 未返回恰好一张图片。');
    const { b64_json: base64, ...imageInfo } = data.data[0];
    const { data: ignored, _request_id: ignoredRequestId, ...info } = data;
    return { bytes: decodeImage(base64), response: { ...info, image: imageInfo }, requestId };
  }
  let completed;
  for await (const event of data) {
    if (event.type?.endsWith('.partial_image')) {
      if (!Number.isInteger(event.partial_image_index) || event.partial_image_index < 0 || event.partial_image_index > 2) throw new Error('API 返回了无效的预览图序号。');
      await onPartial(decodeImage(event.b64_json), event.partial_image_index + 1, params.output_format);
    } else if (event.type?.endsWith('.completed')) {
      if (completed) throw new Error('API 流中出现了多个最终图片事件。');
      const { b64_json: base64, ...info } = event;
      completed = { bytes: decodeImage(base64), response: info, requestId };
    } else if (event.type === 'error' || event.error) {
      throw new Error(event.error?.message || event.message || '图片流返回错误。');
    }
  }
  if (!completed) throw new Error('图片流在最终图片完成前中断；未将预览图当作最终结果保存。');
  return completed;
}
