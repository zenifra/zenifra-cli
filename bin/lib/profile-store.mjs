import { mkdir, chmod, open, rename, unlink } from 'node:fs/promises';
import { unlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function withProfileLock(directory, action, { timeoutMs = 35_000, signal } = {}) {
  signal?.throwIfAborted();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = join(directory, 'profiles.lock');
  const deadline = Date.now() + timeoutMs;
  let handle;
  while (!handle) {
    signal?.throwIfAborted();
    try { handle = await open(path, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error(`Perfis ocupados: ${path}. Aguarde o outro comando. Se ele terminou, verifique o PID no arquivo e remova somente esse lock antes de tentar novamente.`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  const identity = await handle.stat();
  const cleanup = () => {
    try {
      const current = lstatSync(path);
      if (current.ino === identity.ino && current.dev === identity.dev) unlinkSync(path);
    } catch {}
  };
  const interrupt = () => { cleanup(); process.exit(130); };
  process.once('exit', cleanup);
  if (!signal) { process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt); }
  try {
    signal?.throwIfAborted();
    await handle.writeFile(String(process.pid));
    signal?.throwIfAborted();
    return await action();
  }
  finally {
    process.removeListener('exit', cleanup); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    cleanup(); await handle.close();
  }
}
export async function atomicPrivateWrite(path, content, { signal } = {}) {
  signal?.throwIfAborted();
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    signal?.throwIfAborted();
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    signal?.throwIfAborted();
    await rename(temporary, path);
  }
  finally { await handle.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
}
