import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import test from 'node:test';

import {
  normalizeCustomDomains,
  validateValkeyConnection,
  writeValkeyConnectionFile,
} from '../bin/lib/public-ux.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('normalizes custom domains and rejects duplicates with the primary domain', () => {
  assert.deepEqual(normalizeCustomDomains(['Example.TEST.', 'api.example.test']), ['example.test', 'api.example.test']);
  assert.throws(
    () => normalizeCustomDomains(['mcp.example.test'], { primaryDomain: 'mcp.example.test' }),
    /primary domain/i,
  );
  assert.throws(() => normalizeCustomDomains(['a.example.test', 'A.EXAMPLE.TEST.']), /duplicate/i);
});

test('preserves the backend Valkey connection exactly and rejects masked credentials', () => {
  assert.equal(validateValkeyConnection('valkeys://default:secret@example.test:30000/0'), 'valkeys://default:secret@example.test:30000/0');
  assert.equal(validateValkeyConnection('rediss://default:secret@example.test:30000/0'), 'rediss://default:secret@example.test:30000/0');
  assert.equal(validateValkeyConnection('valkeys://default:secret@example.test:30000/0  '), 'valkeys://default:secret@example.test:30000/0  ');
  assert.throws(() => validateValkeyConnection('valkeys://default:********@example.test:30000/0'), /masked/i);
});

test('writes the exact backend Valkey connection with private permissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zenifra-public-ux-'));
  const path = join(directory, 'connection.txt');
  try {
    const connection = 'valkeys://default:file-secret@example.test:30000/0  ';
    await writeValkeyConnectionFile(path, connection);
    assert.equal(await readFile(path, 'utf8'), connection);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('public README documents a neutral API example', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /https:\/\/api\.example\.test\/v1/);
});
