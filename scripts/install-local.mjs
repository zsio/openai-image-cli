import { chmod, lstat, mkdir, readlink, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configPath, initConfig } from '../src/config.mjs';

const source = fileURLToPath(new URL('../bin/gpt-image.mjs', import.meta.url));
const target = join(homedir(), '.local', 'bin', 'gpt-image');
await mkdir(dirname(target), { recursive: true });
await chmod(source, 0o755);
let existing;
try { existing = await lstat(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (existing) {
  if (!existing.isSymbolicLink() || resolve(dirname(target), await readlink(target)) !== source) {
    throw new Error(`已有其他文件占用命令路径，未覆盖：${target}`);
  }
} else {
  await symlink(source, target);
}
const config = configPath();
await initConfig(config);
process.stdout.write(`命令已安装：${target}\n配置文件：${config}\n请在配置文件中填写 OPENAI_API_KEY，然后运行 gpt-image --help。\n`);
if (!(process.env.PATH || '').split(':').includes(dirname(target))) {
  process.stdout.write('请将 ~/.local/bin 加入 PATH。\n');
}
