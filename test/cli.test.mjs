import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const cliPath = resolve('bin/zenifra.mjs');
const apiKey = 'znf_0123456789abcdef01234567_abcdefghijklmnopqrstuvwxyzABCDEFGHI';

function jsonResponse(res, statusCode, payload) {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function withServer(handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    requests.push(req);
    try {
      await handler(req, res);
    } catch (error) {
      jsonResponse(res, 500, { status: 'failed', message: error.message });
    }
  });

  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.address();

  return {
    requests,
    apiBase: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolvePromise) => server.close(resolvePromise)),
  };
}

async function runCli(args, { apiBase = 'http://127.0.0.1:1/v1', configDir } = {}) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      ZENIFRA_API_URL: apiBase,
      ZENIFRA_API_KEY: apiKey,
      ZENIFRA_CONFIG_DIR: configDir,
    },
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

  const code = await new Promise((resolvePromise) => child.on('close', resolvePromise));
  return { code, stdout, stderr };
}

test('global help shows the command index and points to command-specific help', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'zenifra-cli-test-'));
  try {
    const result = await runCli(['--help'], { configDir });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Zenifra CLI/);
    assert.match(result.stdout, /zenifra help <command>/);
    assert.match(result.stdout, /project logs/);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test('subcommand help is specific and does not require authentication', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'zenifra-cli-test-'));
  try {
    const result = await runCli(['project', 'logs', '--help'], { configDir });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Usage:\n  zenifra project logs --project <id>/);
    assert.match(result.stdout, /Description:/);
    assert.match(result.stdout, /Examples:/);
    assert.match(result.stdout, /Example output:/);
    assert.doesNotMatch(result.stdout, /zenifra auth login \[--api-base/);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test('help command resolves compound commands with examples and JSON output', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'zenifra-cli-test-'));
  try {
    const result = await runCli(['help', 'project', 'env', 'add'], { configDir });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Usage:\n  zenifra project env add --project <id> --name <name> --value <value>/);
    assert.match(result.stdout, /--name <name>/);
    assert.match(result.stdout, /zenifra project env add --project/);
    assert.match(result.stdout, /Example JSON output:/);
    assert.match(result.stdout, /\*\*\*\*\*\*\*\*/);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test('unknown help command fails with a clear message', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'zenifra-cli-test-'));
  try {
    const result = await runCli(['help', 'project', 'missing'], { configDir });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Ajuda nao encontrada para: project missing/);
    assert.match(result.stderr, /zenifra help <command>/);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test('every routed command has command-specific help', async () => {
  const commands = [
    ['auth', 'login'],
    ['auth', 'api-key'],
    ['auth', 'logout'],
    ['orgs'],
    ['org', 'set'],
    ['projects'],
    ['projects', 'create'],
    ['project', 'info'],
    ['project', 'url'],
    ['project', 'logs'],
    ['project', 'metrics'],
    ['project', 'network'],
    ['project', 'image', 'set'],
    ['project', 'envs'],
    ['project', 'env', 'add'],
    ['project', 'env', 'update'],
    ['project', 'env', 'remove'],
    ['project', 'instances'],
    ['project', 'instances', 'set'],
    ['builds'],
    ['deployments'],
    ['deploy'],
    ['deploy', 'watch'],
  ];
  const configDir = await mkdtemp(join(tmpdir(), 'zenifra-cli-test-'));

  try {
    for (const command of commands) {
      const result = await runCli([...command, '--help'], { configDir });
      assert.equal(result.code, 0, `${command.join(' ')}\n${result.stderr}`);
      assert.match(result.stdout, new RegExp(`zenifra ${command.join(' ')}`));
      assert.match(result.stdout, /Examples:/);
      assert.doesNotMatch(result.stdout, /Environment:\n  ZENIFRA_API_URL/);
    }
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

async function withCliServer(handler, callback) {
  const configDir = await mkdtemp(join(tmpdir(), 'zenifra-cli-test-'));
  const server = await withServer(handler);
  try {
    return await callback({ ...server, configDir });
  } finally {
    await server.close();
    await rm(configDir, { recursive: true, force: true });
  }
}

function assertApiKeyAuth(req) {
  assert.equal(req.headers.authorization, `Bearer ${apiKey}`);
  assert.equal(req.headers['x-organization-id'], undefined);
}

test('project env add reads current envs, sends the full updated list, and does not print secret values', async () => {
  let patchedBody;

  await withCliServer(async (req, res) => {
    assertApiKeyAuth(req);

    if (req.method === 'GET' && req.url === '/v1/project/proj_1/envs') {
      jsonResponse(res, 200, {
        status: 'success',
        data: [{ name: 'EXISTING', value: 'old-value' }],
      });
      return;
    }

    if (req.method === 'PATCH' && req.url === '/v1/project/proj_1/envs') {
      patchedBody = await readJson(req);
      jsonResponse(res, 200, { status: 'success', message: 'updated with success' });
      return;
    }

    jsonResponse(res, 404, { status: 'failed', message: `unexpected ${req.method} ${req.url}` });
  }, async ({ apiBase, configDir }) => {
    const result = await runCli([
      'project', 'env', 'add',
      '--project', 'proj_1',
      '--name', 'NEW_SECRET',
      '--value', 'super-secret',
    ], { apiBase, configDir });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(patchedBody, {
      envs: [
        { name: 'EXISTING', value: 'old-value' },
        { name: 'NEW_SECRET', value: 'super-secret' },
      ],
    });
    assert.match(result.stdout, /NEW_SECRET/);
    assert.doesNotMatch(result.stdout, /super-secret/);
  });
});

test('project metrics uses API-key auth without organization header and preserves query flags', async () => {
  await withCliServer(async (req, res) => {
    assertApiKeyAuth(req);
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/v1/project/proj_1/metrics?instance=web-1');
    jsonResponse(res, 200, {
      status: 'success',
      data: { type: 'application', instance: 'web-1', cpu: 0.2, memory: 64 },
    });
  }, async ({ apiBase, configDir }) => {
    const result = await runCli([
      'project', 'metrics',
      '--project', 'proj_1',
      '--instance', 'web-1',
      '--json',
    ], { apiBase, configDir });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).instance, 'web-1');
  });
});

test('project logs prints log snapshots from the logs endpoint', async () => {
  await withCliServer(async (req, res) => {
    assertApiKeyAuth(req);
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/v1/project/proj_1/logs?instance=web-1');
    jsonResponse(res, 200, {
      status: 'success',
      data: 'server started\nrequest completed',
    });
  }, async ({ apiBase, configDir }) => {
    const result = await runCli([
      'project', 'logs',
      '--project', 'proj_1',
      '--instance', 'web-1',
    ], { apiBase, configDir });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /server started/);
    assert.match(result.stdout, /request completed/);
  });
});

test('project image and instances commands call their project operation endpoints', async () => {
  const calls = [];

  await withCliServer(async (req, res) => {
    assertApiKeyAuth(req);
    calls.push({ method: req.method, url: req.url, body: req.method === 'GET' ? null : await readJson(req) });

    if (req.method === 'PATCH' && req.url === '/v1/project/proj_1/image') {
      jsonResponse(res, 200, { status: 'success', message: 'updated with success' });
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/project/proj_1/instances') {
      jsonResponse(res, 200, { status: 'success', data: [{ instance: 'web-1' }] });
      return;
    }

    if (req.method === 'PATCH' && req.url === '/v1/project/proj_1/instances') {
      jsonResponse(res, 200, { status: 'success', message: 'project instances changed with success' });
      return;
    }

    jsonResponse(res, 404, { status: 'failed', message: `unexpected ${req.method} ${req.url}` });
  }, async ({ apiBase, configDir }) => {
    const setImage = await runCli([
      'project', 'image', 'set',
      '--project', 'proj_1',
      '--image', 'ghcr.io/zenifra/app:1.2.3',
    ], { apiBase, configDir });
    const listInstances = await runCli([
      'project', 'instances',
      '--project', 'proj_1',
      '--json',
    ], { apiBase, configDir });
    const setInstances = await runCli([
      'project', 'instances', 'set',
      '--project', 'proj_1',
      '--count', '3',
    ], { apiBase, configDir });

    assert.equal(setImage.code, 0, setImage.stderr);
    assert.equal(listInstances.code, 0, listInstances.stderr);
    assert.equal(setInstances.code, 0, setInstances.stderr);
    assert.deepEqual(calls, [
      { method: 'PATCH', url: '/v1/project/proj_1/image', body: { image: 'ghcr.io/zenifra/app:1.2.3' } },
      { method: 'GET', url: '/v1/project/proj_1/instances', body: null },
      { method: 'PATCH', url: '/v1/project/proj_1/instances', body: { instances: 3 } },
    ]);
  });
});
