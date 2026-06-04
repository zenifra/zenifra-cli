import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const cliPath = resolve('bin/zenifra.mjs');
const apiKey = 'znf_0123456789abcdef01234567_abcdefghijklmnopqrstuvwxyzABCDEFGHI';
const HTTP_PLAN_CATALOG = [
  { plan: 'free', prices: { hourly: 0, monthly: 0, yearly: 0 }, features: ['1 GB Armazenamento Efêmero'] },
  { plan: 'static', prices: { hourly: 1, monthly: 10, yearly: 100 }, features: ['2 GB Armazenamento Efêmero'] },
  { plan: 'basic', prices: { hourly: 2, monthly: 20, yearly: 200 }, features: ['2 instâncias'] },
  {
    plan: 'premium',
    prices: { hourly: 3, monthly: 30, yearly: 300 },
    features: ['Sub-domínio HTTP personalizado', 'Bloqueio de IPs', '3 instâncias'],
  },
  { plan: 'premium_plus', prices: { hourly: 4, monthly: 40, yearly: 400 }, features: ['Bloqueio de IPs', '4 instâncias'] },
  { plan: 'business', prices: { hourly: 5, monthly: 50, yearly: 500 }, features: ['5 instâncias'] },
  { plan: 'deep_learning_basic', prices: { hourly: 6, monthly: 60, yearly: 600 }, features: ['2 instâncias'] },
  { plan: 'deep_learning_premium', prices: { hourly: 7, monthly: 70, yearly: 700 }, features: ['Bloqueio de IPs', '4 instâncias'] },
];
const DATABASE_PLAN_CATALOG = [
  { plan: 'db-free', prices: { hourly: 0, monthly: 0, yearly: 0 }, features: ['1 réplica'] },
  { plan: 'db-starter', prices: { hourly: 1, monthly: 10, yearly: 100 }, features: ['1 réplica'] },
  { plan: 'db-basic', prices: { hourly: 2, monthly: 20, yearly: 200 }, features: ['Até 3 réplicas'] },
  { plan: 'db-premium', prices: { hourly: 3, monthly: 30, yearly: 300 }, features: ['Até 4 réplicas'] },
  { plan: 'db-enterprise', prices: { hourly: 4, monthly: 40, yearly: 400 }, features: ['Até 5 réplicas'] },
];
const STORAGE_PLAN_CATALOG = [
  { storage: '1gb_persistente', prices: { hourly: 0.5, monthly: 360, yearly: 4320 }, persistent: true },
  { storage: '1gb_efêmero', prices: { hourly: 0.25, monthly: 180, yearly: 2160 }, persistent: false },
];
const AVAILABLE_INSTANCES = {
  free: 1,
  static: 2,
  basic: 2,
  premium: 3,
  premium_plus: 4,
  business: 5,
  deep_learning_basic: 2,
  deep_learning_premium: 4,
};

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

async function runCli(args, { apiBase = 'http://127.0.0.1:1/v1', configDir, stdin, envApiKey = apiKey, extraEnv = {} } = {}) {
  const env = {
    ...process.env,
    ZENIFRA_API_URL: apiBase,
    ZENIFRA_CONFIG_DIR: configDir,
    ...extraEnv,
  };
  if (envApiKey === null) {
    delete env.ZENIFRA_API_KEY;
  } else {
    env.ZENIFRA_API_KEY = envApiKey;
  }
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: resolve('.'),
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  if (stdin !== undefined) child.stdin.end(stdin);

  const code = await new Promise((resolvePromise) => child.on('close', resolvePromise));
  return { code, stdout, stderr };
}

async function runCliPty(args, { apiBase = 'http://127.0.0.1:1/v1', configDir, stdin, interactions, timeoutMs = 5000 } = {}) {
  const command = [process.execPath, cliPath, ...args]
    .map((part) => `"${String(part).replaceAll('"', '\\"')}"`)
    .join(' ');
  const child = spawn('script', ['-q', '-e', '-c', command, '/dev/null'], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      ZENIFRA_API_URL: apiBase,
      ZENIFRA_API_KEY: apiKey,
      ZENIFRA_CONFIG_DIR: configDir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  const writer = interactions?.length
    ? new Promise((resolvePromise, reject) => {
      let index = 0;
      const trySend = () => {
        while (index < interactions.length) {
          const { waitFor, send } = interactions[index];
          const matched = waitFor instanceof RegExp ? waitFor.test(stdout) : stdout.includes(waitFor);
          if (!matched) return;
          child.stdin.write(send);
          index += 1;
        }
        child.stdin.end();
        resolvePromise();
      };
      child.stdout.on('data', trySend);
      child.stderr.on('data', trySend);
      setTimeout(() => {
        if (index < interactions.length) {
          reject(new Error(`CLI PTY interactions stalled at step ${index + 1}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
        }
      }, timeoutMs - 250);
    })
    : stdin === undefined
      ? Promise.resolve()
      : (async () => {
        const lines = String(stdin).split('\n');
        for (const line of lines) {
          child.stdin.write(`${line}\n`);
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
        }
        child.stdin.end();
      })();

  const code = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`CLI PTY timed out after ${timeoutMs}ms\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
    }, timeoutMs);
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolvePromise(exitCode);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  await writer;

  return { code, stdout, stderr };
}

async function writeProfiles(configDir, payload) {
  await writeFile(join(configDir, 'profiles.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
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

test('deploy without required arguments prints the command help instead of a short validation error', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'zenifra-cli-test-'));
  try {
    const result = await runCli(['deploy'], { configDir });

    assert.equal(result.code, 1);
    assert.match(result.stdout, /Zenifra CLI - deploy/);
    assert.match(result.stdout, /Usage:\n  zenifra deploy --project <id> \[--branch <name>] \[--commit-sha <sha>] \[--json]/);
    assert.match(result.stdout, /zenifra deploy watch --project <id> --build <build_id>/);
    assert.match(result.stdout, /acompanha status e logs incrementais/i);
    assert.match(result.stdout, /Examples:/);
    assert.match(result.stdout, /Deploy iniciado: build_123/);
    assert.equal(result.stderr, '');
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test('deploy watch help explains that it streams incremental build logs until completion', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'zenifra-cli-test-'));
  try {
    const result = await runCli(['help', 'deploy', 'watch'], { configDir });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Zenifra CLI - deploy watch/);
    assert.match(result.stdout, /logs incrementais do build/i);
    assert.match(result.stdout, /estado terminal/i);
    assert.match(result.stdout, /zenifra deploy watch --project 507f1f77bcf86cd799439012 --build build_123 --interval 2/);
    assert.match(result.stdout, /\[2026-05-27T12:00:00.000Z] install: npm ci/);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test('deploy watch without required arguments prints the command help instead of a short validation error', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'zenifra-cli-test-'));
  try {
    const result = await runCli(['deploy', 'watch'], { configDir });

    assert.equal(result.code, 1);
    assert.match(result.stdout, /Zenifra CLI - deploy watch/);
    assert.match(result.stdout, /Usage:\n  zenifra deploy watch --project <id> --build <id> \[--interval <seconds>] \[--timeout <seconds>] \[--json]/);
    assert.match(result.stdout, /logs incrementais do build/i);
    assert.match(result.stdout, /\[2026-05-27T12:00:00.000Z] install: npm ci/);
    assert.equal(result.stderr, '');
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test('commands with missing required arguments print command-specific help instead of terse validation errors', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'zenifra-cli-test-'));
  const cases = [
    { args: ['builds'], title: 'Zenifra CLI - builds' },
    { args: ['deployments'], title: 'Zenifra CLI - deployments' },
    { args: ['builds', 'logs'], title: 'Zenifra CLI - builds logs' },
    { args: ['project', 'info'], title: 'Zenifra CLI - project info' },
    { args: ['project', 'url'], title: 'Zenifra CLI - project url' },
    { args: ['project', 'logs'], title: 'Zenifra CLI - project logs' },
    { args: ['project', 'metrics'], title: 'Zenifra CLI - project metrics' },
    { args: ['project', 'network'], title: 'Zenifra CLI - project network' },
    { args: ['project', 'image', 'set'], title: 'Zenifra CLI - project image set' },
    { args: ['project', 'envs'], title: 'Zenifra CLI - project envs' },
    { args: ['project', 'env', 'add'], title: 'Zenifra CLI - project env add' },
    { args: ['project', 'env', 'update'], title: 'Zenifra CLI - project env update' },
    { args: ['project', 'env', 'remove'], title: 'Zenifra CLI - project env remove' },
    { args: ['project', 'instances'], title: 'Zenifra CLI - project instances' },
    { args: ['project', 'instances', 'set'], title: 'Zenifra CLI - project instances set' },
    { args: ['profile', 'use'], title: 'Zenifra CLI - profile use' },
    { args: ['profile', 'edit'], title: 'Zenifra CLI - profile edit' },
    { args: ['profile', 'remove'], title: 'Zenifra CLI - profile remove' },
  ];

  try {
    for (const testCase of cases) {
      const result = await runCli(testCase.args, { configDir });
      assert.equal(result.code, 1, `${testCase.args.join(' ')}\n${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, new RegExp(testCase.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(result.stdout, /Usage:/);
      assert.equal(result.stderr, '', `${testCase.args.join(' ')}\n${result.stderr}`);
    }
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
    ['auth'],
    ['auth', 'login'],
    ['auth', 'api-key'],
    ['auth', 'logout'],
    ['profile'],
    ['profile', 'list'],
    ['profile', 'show'],
    ['profile', 'add'],
    ['profile', 'edit'],
    ['profile', 'use'],
    ['profile', 'remove'],
    ['org'],
    ['orgs'],
    ['plans'],
    ['org', 'set'],
    ['project'],
    ['projects'],
    ['create', 'project'],
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
    ['builds', 'logs'],
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

test('namespace commands show group help for --help, help <namespace>, and bare namespace', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'zenifra-cli-test-'));
  const namespaces = [
    ['auth', /zenifra auth login/, /Gerencia a autenticacao/],
    ['profile', /zenifra profile list/, /Gerencia perfis de ambiente/],
    ['project', /zenifra project info --project <id>/, /Agrupa comandos operacionais/],
    ['org', /zenifra org set/, /Agrupa comandos relacionados a organizacao/],
  ];

  try {
    for (const [namespace, usagePattern, descriptionPattern] of namespaces) {
      const helpFlag = await runCli([namespace, '--help'], { configDir });
      const helpCommand = await runCli(['help', namespace], { configDir });
      const bareCommand = await runCli([namespace], { configDir });

      for (const result of [helpFlag, helpCommand, bareCommand]) {
        assert.equal(result.code, 0, `${namespace}\n${result.stderr}`);
        assert.match(result.stdout, new RegExp(`Zenifra CLI - ${namespace}`));
        assert.match(result.stdout, usagePattern);
        assert.match(result.stdout, descriptionPattern);
        assert.match(result.stdout, /Examples:/);
      }
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

async function withPlansCatalogServer(handler, callback) {
  return withCliServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/project/plans') {
      jsonResponse(res, 200, { status: 'success', data: HTTP_PLAN_CATALOG });
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/project/database/plans') {
      jsonResponse(res, 200, { status: 'success', data: DATABASE_PLAN_CATALOG });
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/project/storage/plans') {
      jsonResponse(res, 200, { status: 'success', data: STORAGE_PLAN_CATALOG });
      return;
    }

    await handler(req, res);
  }, callback);
}

test('plans help works without authentication', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'zenifra-cli-test-'));
  try {
    for (const args of [['plans', '--help'], ['help', 'plans']]) {
      const result = await runCli(args, { configDir, envApiKey: null });
      assert.equal(result.code, 0, `${args.join(' ')}\n${result.stderr}`);
      assert.match(result.stdout, /Usage:\n  zenifra plans \[--type <all\|http\|database\|storage>] \[--json]/);
      assert.match(result.stdout, /Examples:/);
      assert.doesNotMatch(result.stdout, /Voce precisa autenticar primeiro/);
    }
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test('builds logs help is specific and documents follow mode', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'zenifra-cli-test-'));
  try {
    const result = await runCli(['builds', 'logs', '--help'], { configDir });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Usage:\n  zenifra builds logs --project <id> --build <id>/);
    assert.match(result.stdout, /--follow/);
    assert.match(result.stdout, /Example output:/);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test('plans lists all catalogs without authentication by default', async () => {
  await withPlansCatalogServer(async (req, res) => {
    jsonResponse(res, 404, { status: 'failed', message: `unexpected ${req.method} ${req.url}` });
  }, async ({ apiBase, configDir }) => {
    const result = await runCli(['plans'], { apiBase, configDir, envApiKey: null });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /HTTP/);
    assert.match(result.stdout, /PostgreSQL \/ MariaDB/);
    assert.match(result.stdout, /Armazenamento/);
    assert.match(result.stdout, /free/);
    assert.match(result.stdout, /db-basic/);
    assert.match(result.stdout, /1 GB/);
    assert.match(result.stdout, /Persistente/);
    assert.match(result.stdout, /Efemero/);
  });
});

test('plans --type filters the requested catalog and aliases database types', async () => {
  const scenarios = [
    { type: 'http', expectedPath: '/v1/project/plans', unexpected: ['/v1/project/database/plans', '/v1/project/storage/plans'], expectedText: /HTTP/ },
    { type: 'database', expectedPath: '/v1/project/database/plans', unexpected: ['/v1/project/plans', '/v1/project/storage/plans'], expectedText: /PostgreSQL \/ MariaDB/ },
    { type: 'db', expectedPath: '/v1/project/database/plans', unexpected: ['/v1/project/plans', '/v1/project/storage/plans'], expectedText: /PostgreSQL \/ MariaDB/ },
    { type: 'postgresql', expectedPath: '/v1/project/database/plans', unexpected: ['/v1/project/plans', '/v1/project/storage/plans'], expectedText: /PostgreSQL \/ MariaDB/ },
    { type: 'mariadb', expectedPath: '/v1/project/database/plans', unexpected: ['/v1/project/plans', '/v1/project/storage/plans'], expectedText: /PostgreSQL \/ MariaDB/ },
    { type: 'storage', expectedPath: '/v1/project/storage/plans', unexpected: ['/v1/project/plans', '/v1/project/database/plans'], expectedText: /Armazenamento/ },
  ];

  for (const scenario of scenarios) {
    await withCliServer(async (req, res) => {
      assert.equal(req.headers.authorization, undefined);
      if (req.method === 'GET' && req.url === '/v1/project/plans') {
        jsonResponse(res, 200, { status: 'success', data: HTTP_PLAN_CATALOG });
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/project/database/plans') {
        jsonResponse(res, 200, { status: 'success', data: DATABASE_PLAN_CATALOG });
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/project/storage/plans') {
        jsonResponse(res, 200, { status: 'success', data: STORAGE_PLAN_CATALOG });
        return;
      }
      jsonResponse(res, 404, { status: 'failed', message: 'unexpected request' });
    }, async ({ apiBase, configDir, requests }) => {
      const result = await runCli(['plans', '--type', scenario.type], { apiBase, configDir, envApiKey: null });

      assert.equal(result.code, 0, `${scenario.type}\n${result.stderr}`);
      assert.match(result.stdout, scenario.expectedText);
      assert.deepEqual(
        requests.map((request) => request.url),
        [scenario.expectedPath],
        `${scenario.type}\n${requests.map((request) => request.url).join('\n')}`,
      );
      for (const path of scenario.unexpected) {
        assert.doesNotMatch(result.stdout, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      }
    });
  }
});

test('plans --json returns a stable grouped payload', async () => {
  await withPlansCatalogServer(async (req, res) => {
    jsonResponse(res, 404, { status: 'failed', message: `unexpected ${req.method} ${req.url}` });
  }, async ({ apiBase, configDir }) => {
    const result = await runCli(['plans', '--type', 'storage', '--json'], { apiBase, configDir, envApiKey: null });

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(payload.http, []);
    assert.deepEqual(payload.database, []);
    assert.deepEqual(payload.storage, STORAGE_PLAN_CATALOG);
  });
});

test('plans fails clearly on invalid type', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'zenifra-cli-test-'));
  try {
    const result = await runCli(['plans', '--type', 'redis'], { configDir, envApiKey: null });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Tipo de catalogo invalido/);
    assert.match(result.stderr, /all, http, database, storage/);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test('plans fails instead of printing partial data when one requested catalog fails', async () => {
  await withCliServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/project/plans') {
      jsonResponse(res, 200, { status: 'success', data: HTTP_PLAN_CATALOG });
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/project/database/plans') {
      jsonResponse(res, 500, { status: 'failed', message: 'database catalog unavailable' });
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/project/storage/plans') {
      jsonResponse(res, 200, { status: 'success', data: STORAGE_PLAN_CATALOG });
      return;
    }

    jsonResponse(res, 404, { status: 'failed', message: 'unexpected request' });
  }, async ({ apiBase, configDir }) => {
    const result = await runCli(['plans'], { apiBase, configDir, envApiKey: null });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /database catalog unavailable/);
    assert.equal(result.stdout, '');
  });
});

async function withWizardCatalogServer(postHandler, callback) {
  return withCliServer(async (req, res) => {
    assertApiKeyAuth(req);

    if (req.method === 'GET' && req.url === '/v1/project/plans') {
      jsonResponse(res, 200, { status: 'success', data: HTTP_PLAN_CATALOG });
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/projects/available') {
      jsonResponse(res, 200, { status: 'success', data: AVAILABLE_INSTANCES });
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/project/database/plans') {
      jsonResponse(res, 200, { status: 'success', data: DATABASE_PLAN_CATALOG });
      return;
    }

    await postHandler(req, res);
  }, callback);
}

function assertApiKeyAuth(req) {
  assert.equal(req.headers.authorization, `Bearer ${apiKey}`);
  assert.equal(req.headers['x-organization-id'], undefined);
}

test('legacy session is auto-migrated into the default profile', async () => {
  await withCliServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer legacy_key_123');
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/v1/project?type=http&page=1&limit=15');
    jsonResponse(res, 200, { status: 'success', data: { projects: [], pagination: { page: 1, limit: 15, total: 0, pages: 0 } } });
  }, async ({ apiBase, configDir }) => {
    await writeFile(join(configDir, 'session.json'), `${JSON.stringify({
      apiKey: 'legacy_key_123',
      apiBaseUrl: apiBase,
      updatedAt: '2026-05-31T00:00:00.000Z',
    }, null, 2)}\n`, 'utf8');

    const result = await runCli(['projects', '--type', 'http'], { apiBase, configDir, envApiKey: null });

    assert.equal(result.code, 0, result.stderr);
    const profiles = JSON.parse(await readFile(join(configDir, 'profiles.json'), 'utf8'));
    assert.equal(profiles.activeProfile, 'default');
    assert.equal(profiles.profiles.default.apiKey, 'legacy_key_123');
    assert.equal(profiles.profiles.default.apiBaseUrl, apiBase);
  });
});

test('builds logs reads a build log snapshot', async () => {
  await withCliServer(async (req, res) => {
    assertApiKeyAuth(req);
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/v1/project/proj_123/github/builds/build_123/logs?cursor=0&limit=200');
    jsonResponse(res, 200, {
      status: 'success',
      message: 'build logs retrieved successfully',
      data: {
        logs: [
          {
            sequence: 1,
            timestamp: '2026-06-03T12:00:00.000Z',
            level: 'info',
            step: 'install',
            message: 'added 512 packages',
            final: false,
          },
          {
            sequence: 2,
            timestamp: '2026-06-03T12:00:05.000Z',
            level: 'info',
            step: 'build',
            message: 'build completed',
            final: true,
          },
        ],
        next_cursor: 2,
        status: 'success',
        finished: true,
        truncated: false,
      },
    });
  }, async ({ apiBase, configDir }) => {
    const result = await runCli(['builds', 'logs', '--project', 'proj_123', '--build', 'build_123'], { apiBase, configDir });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /\[2026-06-03T12:00:00.000Z] install: added 512 packages/);
    assert.match(result.stdout, /\[2026-06-03T12:00:05.000Z] build: build completed/);
  });
});

test('deploy watch streams build logs until the build succeeds', async () => {
  let logPollCount = 0;

  await withCliServer(async (req, res) => {
    assertApiKeyAuth(req);
    assert.equal(req.method, 'GET');

    if (req.url === '/v1/project/proj_123/github/builds/build_123/logs?cursor=0&limit=200') {
      logPollCount += 1;
      jsonResponse(res, 200, {
        status: 'success',
        message: 'build logs retrieved successfully',
        data: {
          logs: [
            {
              sequence: 1,
              timestamp: '2026-06-03T12:00:00.000Z',
              level: 'info',
              step: 'install',
              message: 'npm ci',
              final: false,
            },
          ],
          next_cursor: 1,
          status: 'running',
          finished: false,
          truncated: false,
        },
      });
      return;
    }

    if (req.url === '/v1/project/proj_123/github/builds/build_123/logs?cursor=1&limit=200') {
      logPollCount += 1;
      jsonResponse(res, 200, {
        status: 'success',
        message: 'build logs retrieved successfully',
        data: {
          logs: [
            {
              sequence: 2,
              timestamp: '2026-06-03T12:00:03.000Z',
              level: 'info',
              step: 'build',
              message: 'vite build',
              final: false,
            },
            {
              sequence: 3,
              timestamp: '2026-06-03T12:00:06.000Z',
              level: 'info',
              step: 'build',
              message: 'GitHub build and deployment completed successfully',
              final: true,
            },
          ],
          next_cursor: 3,
          status: 'success',
          finished: true,
          truncated: false,
        },
      });
      return;
    }

    jsonResponse(res, 404, { status: 'failed', message: `unexpected ${req.method} ${req.url}` });
  }, async ({ apiBase, configDir }) => {
    const result = await runCli(['deploy', 'watch', '--project', 'proj_123', '--build', 'build_123', '--interval', '0.01'], { apiBase, configDir });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(logPollCount, 2);
    assert.match(result.stdout, /\[2026-06-03T12:00:00.000Z] install: npm ci/);
    assert.match(result.stdout, /\[2026-06-03T12:00:03.000Z] build: vite build/);
    assert.match(result.stdout, /\[2026-06-03T12:00:06.000Z] build: GitHub build and deployment completed successfully/);
  });
});

test('projects command requests paginated project lists and prints pagination summary', async () => {
  await withCliServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${apiKey}`);
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/v1/project?type=http&page=2&limit=15');
    jsonResponse(res, 200, {
      status: 'success',
      data: {
        projects: [
          {
            id: '507f1f77bcf86cd799439012',
            name: 'api-web',
            status: 'running',
            plan: 'free',
            type_project: 'http',
          },
        ],
        pagination: { page: 2, limit: 15, total: 31, pages: 3 },
      },
    });
  }, async ({ apiBase, configDir }) => {
    const result = await runCli(['projects', '--type', 'http', '--page', '2', '--limit', '15'], { apiBase, configDir });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /api-web/);
    assert.match(result.stdout, /Pagina 2 de 3 \(31 projeto\(s\)\)/);
  });
});

test('profile list and show expose the active profile with masked credentials', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'zenifra-cli-test-'));
  try {
    await writeProfiles(configDir, {
      version: 1,
      activeProfile: 'prod',
      profiles: {
        prod: {
          name: 'prod',
          description: 'Producao',
          authMode: 'api_key',
          apiBaseUrl: 'https://api.zenifra.com/v1',
          apiKey,
        },
        staging: {
          name: 'staging',
          description: 'Homologacao',
          authMode: 'access_token',
          apiBaseUrl: 'https://api-stg.zenifra.com/v1',
          accessToken: 'token_staging',
          selectedOrganizationId: 'org_stg',
        },
      },
    });

    const list = await runCli(['profile', 'list'], { configDir, envApiKey: null });
    const show = await runCli(['profile', 'show'], { configDir, envApiKey: null });

    assert.equal(list.code, 0, list.stderr);
    assert.match(list.stdout, /prod\s+api_key\s+https:\/\/api\.zenifra\.com\/v1\s+yes/);
    assert.match(list.stdout, /staging\s+access_token\s+https:\/\/api-stg\.zenifra\.com\/v1\s+no/);
    assert.equal(show.code, 0, show.stderr);
    assert.match(show.stdout, /Nome: prod/);
    assert.match(show.stdout, /API key: znf_0123\.\.\.FGHI/);
    assert.doesNotMatch(show.stdout, new RegExp(apiKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test('auth api-key with --profile creates and activates the target profile', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'zenifra-cli-test-'));
  try {
    const result = await runCli(['auth', 'api-key', '--profile', 'staging', '--api-base', 'https://api-stg.zenifra.com/v1', '--key', apiKey], {
      configDir,
      envApiKey: null,
    });

    assert.equal(result.code, 0, result.stderr);
    const profiles = JSON.parse(await readFile(join(configDir, 'profiles.json'), 'utf8'));
    assert.equal(profiles.activeProfile, 'staging');
    assert.equal(profiles.profiles.staging.apiBaseUrl, 'https://api-stg.zenifra.com/v1');
    assert.equal(profiles.profiles.staging.apiKey, apiKey);
    assert.equal(profiles.profiles.staging.selectedOrganizationId, undefined);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test('profile use switches the active profile used by existing commands', async () => {
  await withCliServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer key_two');
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/v1/project?page=1&limit=15');
    jsonResponse(res, 200, { status: 'success', data: { projects: [], pagination: { page: 1, limit: 15, total: 0, pages: 0 } } });
  }, async ({ apiBase, configDir }) => {
    await writeProfiles(configDir, {
      version: 1,
      activeProfile: 'one',
      profiles: {
        one: { name: 'one', apiBaseUrl: apiBase, authMode: 'api_key', apiKey: 'key_one' },
        two: { name: 'two', apiBaseUrl: apiBase, authMode: 'api_key', apiKey: 'key_two' },
      },
    });

    const useResult = await runCli(['profile', 'use', 'two'], { apiBase, configDir, envApiKey: null });
    const projects = await runCli(['projects'], { apiBase, configDir, envApiKey: null });

    assert.equal(useResult.code, 0, useResult.stderr);
    assert.equal(projects.code, 0, projects.stderr);
    assert.match(useResult.stdout, /Perfil ativo: two/);
  });
});

test('environment overrides win over the active profile without mutating profiles.json', async () => {
  await withCliServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer env_key_override');
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/v1/project?page=1&limit=15');
    jsonResponse(res, 200, { status: 'success', data: { projects: [], pagination: { page: 1, limit: 15, total: 0, pages: 0 } } });
  }, async ({ apiBase, configDir }) => {
    await writeProfiles(configDir, {
      version: 1,
      activeProfile: 'prod',
      profiles: {
        prod: { name: 'prod', apiBaseUrl: 'https://api.zenifra.com/v1', authMode: 'api_key', apiKey: 'persisted_key' },
      },
    });

    const result = await runCli(['projects'], {
      apiBase,
      configDir,
      envApiKey: 'env_key_override',
      extraEnv: { ZENIFRA_API_URL: apiBase },
    });

    assert.equal(result.code, 0, result.stderr);
    const profiles = JSON.parse(await readFile(join(configDir, 'profiles.json'), 'utf8'));
    assert.equal(profiles.profiles.prod.apiKey, 'persisted_key');
    assert.equal(profiles.profiles.prod.apiBaseUrl, 'https://api.zenifra.com/v1');
  });
});

test('auth logout clears only the target profile authentication', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'zenifra-cli-test-'));
  try {
    await writeProfiles(configDir, {
      version: 1,
      activeProfile: 'prod',
      profiles: {
        prod: { name: 'prod', description: 'Producao', apiBaseUrl: 'https://api.zenifra.com/v1', authMode: 'api_key', apiKey },
        staging: { name: 'staging', description: 'Homologacao', apiBaseUrl: 'https://api-stg.zenifra.com/v1', authMode: 'access_token', accessToken: 'token_1', selectedOrganizationId: 'org_1' },
      },
    });

    const result = await runCli(['auth', 'logout', '--profile', 'staging'], { configDir, envApiKey: null });

    assert.equal(result.code, 0, result.stderr);
    const profiles = JSON.parse(await readFile(join(configDir, 'profiles.json'), 'utf8'));
    assert.match(result.stdout, /Autenticacao removida do perfil staging/);
    assert.equal(profiles.profiles.staging.accessToken, undefined);
    assert.equal(profiles.profiles.staging.apiKey, undefined);
    assert.equal(profiles.profiles.staging.selectedOrganizationId, undefined);
    assert.equal(profiles.profiles.staging.description, 'Homologacao');
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test('profile remove rejects deleting the active profile', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'zenifra-cli-test-'));
  try {
    await writeProfiles(configDir, {
      version: 1,
      activeProfile: 'prod',
      profiles: {
        prod: { name: 'prod', apiBaseUrl: 'https://api.zenifra.com/v1', authMode: 'api_key', apiKey },
      },
    });

    const result = await runCli(['profile', 'remove', 'prod'], { configDir, envApiKey: null });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Nao e permitido remover o perfil ativo/);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

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

test('create project fails early when plan is invalid', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'zenifra-cli-test-'));
  try {
    const result = await runCli([
      'create', 'project',
      '--name', 'api-web',
      '--plan', 'unknown-plan',
      '--payment-mode', 'hourly',
      '--config', '{"type_project":"http","github":{"runtime":"nodejs"}}',
    ], { configDir });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Plano invalido/);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test('create project fails early when payment mode is invalid', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'zenifra-cli-test-'));
  try {
    const result = await runCli([
      'create', 'project',
      '--name', 'api-web',
      '--plan', 'free',
      '--payment-mode', 'weekly',
      '--config', '{"type_project":"http","github":{"runtime":"nodejs"}}',
    ], { configDir });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Modo de pagamento invalido/);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test('create project fails when github runtime is missing for http github project', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'zenifra-cli-test-'));
  try {
    const result = await runCli([
      'create', 'project',
      '--name', 'api-web',
      '--plan', 'free',
      '--payment-mode', 'hourly',
      '--config', '{"type_project":"http","github":{"repository_owner":"zenifra","repository_name":"api-web","branch":"main"}}',
    ], { configDir });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Runtime invalido/);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test('create project fails early when http exposure is missing', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'zenifra-cli-test-'));
  try {
    const result = await runCli([
      'create', 'project',
      '--name', 'api-web',
      '--plan', 'free',
      '--payment-mode', 'hourly',
      '--config', '{"type_project":"http","github":{"runtime":"nodejs"}}',
    ], { configDir });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /exposure invalido/);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test('create project normalizes aliases before calling API', async () => {
  let body;
  await withCliServer(async (req, res) => {
    assertApiKeyAuth(req);
    if (req.method !== 'POST' || req.url !== '/v1/project') {
      jsonResponse(res, 404, { status: 'failed', message: `unexpected ${req.method} ${req.url}` });
      return;
    }

    body = await readJson(req);
    jsonResponse(res, 200, { status: 'success', data: { id: 'proj_1', domain: 'proj_1.client.zenifra.com' } });
  }, async ({ apiBase, configDir }) => {
    const result = await runCli([
      'create', 'project',
      '--name', 'api-web',
      '--plan', 'premium plus',
      '--payment-mode', 'por ano',
      '--config', '{"type_project":"HTTP","exposure":"publico","github":{"runtime":"Node.js"}}',
    ], { apiBase, configDir });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(body.plan, 'premium_plus');
    assert.equal(body.payment_mode, 'yearly');
    assert.equal(body.config.type_project, 'http');
    assert.equal(body.config.exposure, 'public');
    assert.equal(body.config.github.runtime, 'nodejs');
  });
});

test('create project launches the wizard for an http OCI project', async () => {
  let body;
  await withWizardCatalogServer(async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/project');
    body = await readJson(req);
    jsonResponse(res, 200, { status: 'success', data: { id: 'proj_1', domain: 'proj_1.client.zenifra.com' } });
  }, async ({ apiBase, configDir }) => {
    const stdin = [
      'api-web',
      '',
      '1',
      '1',
      '1',
      '2',
      '8080',
      '1',
      'n',
      '1',
      's',
      'registry.example.com/team/api:1.0.0',
      's',
    ].join('\n');

    const result = await runCli(['create', 'project'], { apiBase, configDir, stdin });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(body.name, 'api-web');
    assert.equal(body.plan, 'free');
    assert.equal(body.payment_mode, 'hourly');
    assert.equal(body.config.type_project, 'http');
    assert.equal(body.config.exposure, 'public');
    assert.deepEqual(body.config.image, {
      url: 'registry.example.com/team/api:1.0.0',
      is_public: true,
    });
    assert.equal(body.config.port, 8080);
    assert.equal(body.config.instances, 1);
    assert.deepEqual(body.config.storage, {
      persistent: false,
      capacity: 1,
    });
    assert.deepEqual(body.config.envs, []);
    assert.deepEqual(body.config.network_access, {
      ingress_white_list: [{ cidr: '0.0.0.0/0', description: 'Allow all' }],
      ingress_black_list: [],
    });
    assert.equal(body.config.subdomain, undefined);
    assert.match(result.stdout, /Wizard interativo/);
    assert.match(result.stdout, /\[1\/\d+\] Nome do projeto\*/);
    assert.match(result.stdout, /\[3\/\d+\] Tipo do projeto\* \[1=http 2=postgresql 3=mariadb\]/);
    assert.doesNotMatch(result.stdout, /^Obrigatorio:/m);
    assert.doesNotMatch(result.stdout, /custom domains/i);
    assert.doesNotMatch(result.stdout, /Subdomain personalizado/i);
    assert.doesNotMatch(result.stdout, /whitelist personalizada/i);
    assert.doesNotMatch(result.stdout, /blacklist de entrada/i);
  });
});

test('create project wizard creates a private http project without public routing prompts', async () => {
  let body;
  await withWizardCatalogServer(async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/project');
    body = await readJson(req);
    jsonResponse(res, 200, { status: 'success', data: { id: 'proj_private_http_1' } });
  }, async ({ apiBase, configDir }) => {
    const stdin = [
      'api-private',
      '',
      '1',
      '3',
      '1',
      '2',
      '8080',
      '2',
      'n',
      '5',
      'n',
      '2',
      's',
      'registry.example.com/team/api:1.0.0',
      's',
    ].join('\n');

    const result = await runCli(['create', 'project'], { apiBase, configDir, stdin });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(body.config.exposure, 'private');
    assert.equal(body.config.subdomain, undefined);
    assert.deepEqual(body.config.network_access, {
      ingress_white_list: [{ cidr: '0.0.0.0/0', description: 'Allow all' }],
      ingress_black_list: [],
    });
    assert.match(result.stdout, /Exposicao HTTP\* \[1=public 2=private\]/);
    assert.doesNotMatch(result.stdout, /Subdomain personalizado/i);
    assert.doesNotMatch(result.stdout, /whitelist personalizada/i);
    assert.doesNotMatch(result.stdout, /blacklist de entrada/i);
  });
});

test('create project wizard re-prompts invalid runtime and creates an http github project', async () => {
  let body;
  await withWizardCatalogServer(async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/project');
    body = await readJson(req);
    jsonResponse(res, 200, { status: 'success', data: { id: 'proj_gh_1', domain: 'proj-gh.client.zenifra.com' } });
  }, async ({ apiBase, configDir }) => {
    const stdin = [
      'gh-webapp',
      '',
      '1',
      '1',
      '2',
      '1',
      '3000',
      '1',
      'n',
      '1',
      'zenifra',
      'zenifra-cli',
      'main',
      'ruby',
      'nodejs',
      '24',
      's',
      'npm start',
      '',
      'npm run build',
      's',
    ].join('\n');

    const result = await runCli(['create', 'project'], { apiBase, configDir, stdin });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(body.config.type_project, 'http');
    assert.deepEqual(body.config.github, {
      repository_owner: 'zenifra',
      repository_name: 'zenifra-cli',
      branch: 'main',
      runtime: 'nodejs',
      version: '24',
      auto_deploy: true,
      start_command: 'npm start',
      pre_build_command: null,
      build_command: 'npm run build',
    });
    assert.deepEqual(body.config.storage, {
      persistent: false,
      capacity: 1,
    });
    assert.match(result.stdout, /valor invalido: use nodejs ou python/i);
  });
});

test('create project wizard shows field help when user types question mark', async () => {
  let body;
  await withWizardCatalogServer(async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/project');
    body = await readJson(req);
    jsonResponse(res, 200, { status: 'success', data: { id: 'proj_help_1' } });
  }, async ({ apiBase, configDir }) => {
    const stdin = [
      '?',
      'api-web',
      '',
      '1',
      '1',
      '1',
      '2',
      '8080',
      '1',
      'n',
      '1',
      's',
      'registry.example.com/team/api:1.0.0',
      's',
    ].join('\n');

    const result = await runCli(['create', 'project'], { apiBase, configDir, stdin });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(body.name, 'api-web');
    assert.match(result.stdout, /Ajuda: Nome do projeto/);
    assert.match(result.stdout, /docs: https:\/\/docs\.zenifra\.com\/pt\/docs\/configuration/i);
    assert.match(result.stdout, /\[1\/\d+\] Nome do projeto\*/);
  });
});

test('create project wizard only shows http plans after selecting http type', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'zenifra-cli-test-'));
  const server = await withServer(async (req, res) => {
    assertApiKeyAuth(req);
    if (req.method === 'GET' && req.url === '/v1/project/plans') {
      jsonResponse(res, 200, { status: 'success', data: HTTP_PLAN_CATALOG });
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/projects/available') {
      jsonResponse(res, 200, { status: 'success', data: AVAILABLE_INSTANCES });
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/project/database/plans') {
      jsonResponse(res, 200, { status: 'success', data: DATABASE_PLAN_CATALOG });
      return;
    }
    jsonResponse(res, 404, { status: 'failed', message: `unexpected ${req.method} ${req.url}` });
  });
  try {
    const stdin = [
      'api-web',
      '',
      '1',
      '?',
    ].join('\n');

    const result = await runCli(['create', 'project'], { apiBase: server.apiBase, configDir, stdin });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Entrada interativa incompleta para o wizard/);
    assert.match(result.stdout, /\[4\/\d+\] Plano\*/);
    assert.match(result.stdout, /opcoes: 1=free \| 2=static \| 3=basic \| 4=premium \| 5=premium_plus \| 6=business \| 7=deep_learning_basic \| 8=deep_learning_premium/i);
    assert.doesNotMatch(result.stdout, /db-basic/i);
    assert.doesNotMatch(result.stdout, /db-premium/i);
    assert.doesNotMatch(result.stdout, /db-starter/i);
    assert.doesNotMatch(result.stdout, /db-enterprise/i);
    assert.doesNotMatch(result.stdout, /db-free/i);
  } finally {
    await server.close();
    await rm(configDir, { recursive: true, force: true });
  }
});

test('create project wizard hides subdomain and network prompts for http basic plan', async () => {
  let body;
  await withWizardCatalogServer(async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/project');
    body = await readJson(req);
    jsonResponse(res, 200, { status: 'success', data: { id: 'proj_basic_http_1' } });
  }, async ({ apiBase, configDir }) => {
    const stdin = [
      'api-basic',
      '',
      '1',
      '3',
      '1',
      '2',
      '8080',
      '2',
      'n',
      '5',
      'n',
      '1',
      's',
      'registry.example.com/team/api:1.0.0',
      's',
    ].join('\n');

    const result = await runCli(['create', 'project'], { apiBase, configDir, stdin });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(body.plan, 'basic');
    assert.equal(body.config.subdomain, undefined);
    assert.deepEqual(body.config.network_access, {
      ingress_white_list: [{ cidr: '0.0.0.0/0', description: 'Allow all' }],
      ingress_black_list: [],
    });
    assert.doesNotMatch(result.stdout, /Subdomain personalizado/i);
    assert.doesNotMatch(result.stdout, /whitelist personalizada/i);
    assert.doesNotMatch(result.stdout, /blacklist de entrada/i);
  });
});

test('create project wizard shows dynamic totals for a short http oci flow', async () => {
  await withWizardCatalogServer(async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/project');
    jsonResponse(res, 200, { status: 'success', data: { id: 'proj_dynamic_1', domain: 'proj-dynamic.client.zenifra.com' } });
  }, async ({ apiBase, configDir }) => {
    const stdin = [
      'asdasdasdsad',
      '',
      '1',
      '3',
      '1',
      '2',
      '80',
      '1',
      'n',
      '1',
      'n',
      '1',
      's',
      'docker.io/nginx:perl',
      's',
    ].join('\n');

    const result = await runCli(['create', 'project'], { apiBase, configDir, stdin });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /\[14\/15\] Image URL\*/);
    assert.match(result.stdout, /\[15\/15\] Confirmar criacao do projeto\* \[s\/n\]/);
  });
});

test('create project wizard creates a postgresql project with transport shim fields', async () => {
  let body;
  await withWizardCatalogServer(async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/project');
    body = await readJson(req);
    jsonResponse(res, 200, { status: 'success', data: { id: 'pg_1' } });
  }, async ({ apiBase, configDir }) => {
    const stdin = [
      'db-app-01',
      '',
      '2',
      '1',
      '3',
      '4',
      '3',
      '20',
      's',
    ].join('\n');

    const result = await runCli(['create', 'project'], { apiBase, configDir, stdin });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(body.plan, 'db-basic');
    assert.equal(body.payment_mode, 'yearly');
    assert.deepEqual(body.config, {
      type_project: 'postgresql',
      version: '18',
      instances: 3,
      storage: {
        persistent: true,
        capacity: 20,
      },
      envs: [],
      network_access: {
        ingress_white_list: [{ cidr: '0.0.0.0/0', description: 'Allow all' }],
        ingress_black_list: [],
      },
    });
  });
});

test('create project wizard locks db-free storage for postgresql', async () => {
  let body;
  await withWizardCatalogServer(async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/project');
    body = await readJson(req);
    jsonResponse(res, 200, { status: 'success', data: { id: 'pg_free_1' } });
  }, async ({ apiBase, configDir }) => {
    const stdin = [
      'db-free-app',
      '',
      '2',
      '5',
      '1',
      '4',
      '1',
      's',
    ].join('\n');

    const result = await runCli(['create', 'project'], { apiBase, configDir, stdin });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(body.plan, 'db-free');
    assert.deepEqual(body.config.storage, {
      persistent: true,
      capacity: 1,
    });
    assert.doesNotMatch(result.stdout, /Capacidade de storage do banco/i);
  });
});

test('create project wizard can be cancelled at the confirmation step', async () => {
  let createCalls = 0;
  await withWizardCatalogServer(async (req, res) => {
    createCalls += 1;
    jsonResponse(res, 200, { status: 'success', data: { id: 'should-not-happen' } });
  }, async ({ apiBase, configDir }) => {
    const stdin = [
      'api-web',
      '',
      '1',
      '1',
      '1',
      '2',
      '8080',
      '1',
      'n',
      '1',
      's',
      'registry.example.com/team/api:1.0.0',
      'n',
    ].join('\n');

    const result = await runCli(['create', 'project'], { apiBase, configDir, stdin });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(createCalls, 0);
    assert.match(result.stdout, /Operacao cancelada pelo usuario/);
    assert.match(result.stdout, /\[\d+\/\d+\] Confirmar criacao do projeto\* \[s\/n\]/);
  });
});

test('create project wizard closes the tty and prints a success table with full domain url', async () => {
  await withWizardCatalogServer(async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/project');
    jsonResponse(res, 200, {
      status: 'success',
      data: {
        id: 'proj_tty_1',
        domain: 'proj-tty.client.zenifra.com',
        api_key: 'api_key_tty_123',
      },
    });
  }, async ({ apiBase, configDir }) => {
    const result = await runCliPty(['create', 'project'], {
      apiBase,
      configDir,
      interactions: [
        { waitFor: /Nome do projeto/, send: 'api-web\n' },
        { waitFor: /Descricao/, send: '\n' },
        { waitFor: /Tipo do projeto/, send: '1\n' },
        { waitFor: /Plano/, send: '3\n' },
        { waitFor: /Modo de pagamento/, send: '1\n' },
        { waitFor: /Origem do deploy HTTP/, send: '2\n' },
        { waitFor: /Porta da aplicacao/, send: '8080\n' },
        { waitFor: /Quantidade de instancias/, send: '1\n' },
        { waitFor: /Storage persistente/, send: 'n\n' },
        { waitFor: /Capacidade de storage/, send: '1\n' },
        { waitFor: /Deseja adicionar variaveis de ambiente/, send: 's\n' },
        { waitFor: /Nome da env/, send: 'PORT\n' },
        { waitFor: /Valor da env/, send: '8080\n' },
        { waitFor: /Deseja adicionar mais um item/, send: 'n\n' },
        { waitFor: /Exposicao HTTP/, send: '1\n' },
        { waitFor: /Imagem publica/, send: 's\n' },
        { waitFor: /Image URL/, send: 'registry.example.com/team/api:1.0.0\n' },
        { waitFor: /Confirmar criacao do projeto/, send: 's\n' },
      ],
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /\r?\n\r?\nCampo\s+Valor/);
    assert.match(result.stdout, /Projeto\s+proj_tty_1/);
    assert.match(result.stdout, /Dominio\s+https:\/\/proj-tty\.client\.zenifra\.com/);
    assert.match(result.stdout, /API key\s+api_key_tty_123/);
  });
});

test('projects create fails with a migration message', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'zenifra-cli-test-'));
  try {
    const result = await runCli(['projects', 'create'], { configDir });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Comando removido\. Use "zenifra create project"\./);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test('projects create --help fails with a migration message', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'zenifra-cli-test-'));
  try {
    const result = await runCli(['projects', 'create', '--help'], { configDir });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Comando removido\. Use "zenifra create project"\./);
    assert.match(result.stderr, /zenifra help create project|zenifra create project --help/);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test('auth api-key stores the local profile store with owner-only permissions', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'zenifra-cli-test-'));

  try {
    const result = await runCli(['auth', 'api-key', '--key', apiKey], { configDir, envApiKey: null });

    assert.equal(result.code, 0, result.stderr);
    const mode = (await stat(join(configDir, 'profiles.json'))).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});
