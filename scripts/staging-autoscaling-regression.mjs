#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const cliPath = resolve(repoRoot, 'bin/zenifra.mjs');
const artifactDir = resolve(repoRoot, 'artifacts');
const summaryPath = resolve(artifactDir, 'staging-autoscaling-regression-summary.json');

const apiBase = (process.env.ZENIFRA_API_URL_STG || process.env.ZENIFRA_API_URL || 'https://api-stg.zenifra.com/v1').replace(/\/$/, '');
const apiKey = process.env.ZENIFRA_API_KEY_STG || process.env.ZENIFRA_API_KEY;
const organizationId = process.env.ZENIFRA_ORGANIZATION_ID_STG || process.env.ZENIFRA_ORGANIZATION_ID;
const skipHourlyWait = process.env.ZENIFRA_STAGING_SKIP_HOURLY_WAIT === '1';

if (!apiKey) {
  throw new Error('Missing ZENIFRA_API_KEY_STG or ZENIFRA_API_KEY');
}

const createdProjects = [];
const evidence = [];
const startedAt = new Date();
const prefix = `rg${Date.now().toString().slice(-6)}`;

function log(message, data) {
  const suffix = data === undefined ? '' : ` ${JSON.stringify(data)}`;
  process.stdout.write(`[${new Date().toISOString()}] ${message}${suffix}\n`);
}

function runCli(args, options = {}) {
  const result = spawnSync('node', [cliPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: options.timeout || 180_000,
    env: {
      ...process.env,
      NO_COLOR: '1',
      ZENIFRA_API_URL: apiBase,
      ZENIFRA_API_KEY: apiKey,
      ...(organizationId ? { ZENIFRA_ORGANIZATION_ID: organizationId } : {}),
    },
  });

  if (options.allowFail) {
    return result;
  }

  if (result.status !== 0) {
    throw new Error(`CLI failed: ${args.join(' ')}\nstdout=${redact(result.stdout)}\nstderr=${redact(result.stderr)}`);
  }

  return result;
}

function redact(value) {
  return String(value || '')
    .replace(/znf_[A-Za-z0-9._-]+/g, 'znf_***')
    .replace(/api_key_[A-Za-z0-9._-]+/g, 'api_key_***')
    .replace(/"api_key"\s*:\s*"[^"]+"/g, '"api_key":"***"');
}

function parseJson(stdout) {
  const text = stdout.trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');

  if (start < 0 || end < 0) {
    throw new Error(`JSON output not found: ${redact(stdout)}`);
  }

  return JSON.parse(text.slice(start, end + 1));
}

function cliJson(args, options = {}) {
  return parseJson(runCli([...args, '--json'], options).stdout);
}

function authHeaders() {
  return {
    authorization: `Bearer ${apiKey}`,
    accept: 'application/json',
    'content-type': 'application/json',
    ...(organizationId ? { 'x-organization-id': organizationId } : {}),
  };
}

async function api(method, route, body, allowStatuses = []) {
  const response = await fetch(`${apiBase}${route}`, {
    method,
    headers: authHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;

  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = redact(text);
  }

  if (!response.ok && !allowStatuses.includes(response.status)) {
    throw new Error(`API ${method} ${route} failed with ${response.status}: ${redact(text)}`);
  }

  return { status: response.status, payload };
}

function httpConfig({ persistent = false, capacity = 1 } = {}) {
  return {
    type_project: 'http',
    exposure: 'public',
    image: {
      url: 'docker.io/nginx:perl',
      is_public: true,
    },
    port: 80,
    instances: 1,
    storage: persistent
      ? { persistent: true, dir_path_to_persist: '/data', capacity }
      : { persistent: false, capacity },
    envs: [],
    network_access: {
      ingress_white_list: [{ cidr: '0.0.0.0/0', description: 'Allow all' }],
      ingress_black_list: [],
    },
  };
}

function projectIdFromCreate(payload) {
  return payload?.data?.project_id || payload?.data?.id || payload?.data?._id || payload?.id || payload?._id;
}

function projectData(payload) {
  const project = payload?.data || payload || {};
  return {
    id: project.id || project._id,
    name: project.name,
    status: project.status,
    plan: project.plan,
    instances: project.instances,
    current_instances: project.additional_info?.current_instances,
    domain: project.domain || project.additional_info?.domain,
    autoscaling: project.autoscaling || project.additional_info?.autoscaling,
    storage: project.storage || project.config?.storage,
  };
}

async function createProject(suffix, plan, config = httpConfig()) {
  const name = `${prefix}-${suffix}`.slice(0, 32);
  log('creating project', { name, plan, storage: config.storage });

  const payload = parseJson(runCli([
    'create',
    'project',
    '--name',
    name,
    '--plan',
    plan,
    '--payment-mode',
    'hourly',
    '--config',
    JSON.stringify(config),
    '--json',
  ], { timeout: 300_000 }).stdout);

  const id = projectIdFromCreate(payload);
  if (!id) {
    throw new Error(`Project id not found for ${name}`);
  }

  createdProjects.push({ id, name });
  log('created project', { id, name, plan });
  return id;
}

async function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function waitProjectStatus(id, status, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  let lastProject = null;

  while (Date.now() < deadline) {
    lastProject = projectData(cliJson(['project', 'info', '--project', id]));
    if (lastProject.status === status) {
      return lastProject;
    }
    await wait(10_000);
  }

  throw new Error(`Project ${id} did not reach status ${status}. Last state: ${JSON.stringify(lastProject)}`);
}

async function projectUrl(id) {
  const payload = cliJson(['project', 'url', '--project', id]);
  const url = payload?.url || payload?.data?.url || payload?.data?.domain || payload?.domain;

  if (url) {
    return String(url).startsWith('http') ? String(url) : `https://${url}`;
  }

  const project = projectData(cliJson(['project', 'info', '--project', id]));
  if (!project.domain) {
    throw new Error(`Project ${id} has no public URL`);
  }

  return String(project.domain).startsWith('http') ? project.domain : `https://${project.domain}`;
}

async function generateTraffic(id, seconds = 90, concurrency = 20) {
  const url = await projectUrl(id);
  const until = Date.now() + seconds * 1000;
  let ok = 0;
  let fail = 0;

  log('starting traffic', { id, seconds, concurrency });

  async function worker() {
    while (Date.now() < until) {
      try {
        const response = await fetch(`${url}?r=${Math.random()}`, { signal: AbortSignal.timeout(5_000) });
        if (response.status < 500) {
          ok += 1;
        } else {
          fail += 1;
        }
        await response.arrayBuffer().catch(() => undefined);
      } catch {
        fail += 1;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  log('finished traffic', { id, ok, fail });
}

function autoscalingEvents(id, extra = []) {
  const payload = cliJson(['project', 'autoscaling', 'events', '--project', id, '--page', '1', '--limit', '100', ...extra]);
  return payload?.events || payload?.data?.events || payload?.data || [];
}

async function waitForAutoscalingEvent(id, predicate, label, timeoutMs = 420_000) {
  const deadline = Date.now() + timeoutMs;
  let lastEvents = [];

  while (Date.now() < deadline) {
    lastEvents = autoscalingEvents(id);
    const event = lastEvents.find(predicate);

    if (event) {
      return event;
    }

    await wait(15_000);
  }

  throw new Error(`Autoscaling event ${label} not observed for ${id}. Last events: ${JSON.stringify(lastEvents.slice(0, 5))}`);
}

function setAutoscaling(id, min, max, cpu = 1, memory = 1) {
  const update = cliJson([
    'project',
    'autoscaling',
    'set',
    '--project',
    id,
    '--min',
    String(min),
    '--max',
    String(max),
    '--cpu',
    String(cpu),
    '--memory',
    String(memory),
  ]);
  const state = cliJson(['project', 'autoscaling', '--project', id]);
  return { update, state };
}

async function changePlan(id, plan) {
  const response = await api('PATCH', `/project/${id}/plan`, { plan });
  await wait(12_000);
  return {
    status: response.status,
    project: projectData(cliJson(['project', 'info', '--project', id])),
  };
}

async function stopProject(id) {
  return api('PATCH', `/project/${id}/stop`, {}, [400, 404]);
}

async function deleteProject(id) {
  return api('DELETE', `/project/${id}`, undefined, [400, 404]);
}

async function hourlyUsage(id) {
  return api('GET', `/project/${id}/billing/hourly-usage?page=1&limit=50`, undefined, [404]);
}

function nextClosedHourWithMargin(now = new Date()) {
  const hour = new Date(now);
  hour.setUTCMinutes(0, 0, 0);
  hour.setUTCHours(hour.getUTCHours() + 1);
  return new Date(hour.getTime() + 6 * 60 * 1000);
}

async function waitHourlyUsage(id) {
  if (skipHourlyWait) {
    return {
      skipped: true,
      before: await hourlyUsage(id),
      after: null,
    };
  }

  const before = await hourlyUsage(id);
  const target = nextClosedHourWithMargin();

  log('waiting hourly usage window', {
    id,
    target: target.toISOString(),
    before_total: before.payload?.data?.pagination?.total || 0,
  });

  while (Date.now() < target.getTime()) {
    await wait(Math.min(60_000, target.getTime() - Date.now()));
  }

  const deadline = Date.now() + 15 * 60_000;
  let after = null;

  while (Date.now() < deadline) {
    after = await hourlyUsage(id);
    const total = after.payload?.data?.pagination?.total || after.payload?.data?.hours?.length || 0;
    log('hourly usage poll', { id, total });

    if (total > 0) {
      return { skipped: false, before, after };
    }

    await wait(60_000);
  }

  throw new Error(`Hourly usage snapshot did not appear for ${id}`);
}

async function scenarioFreePlanDenied() {
  const id = await createProject('free', 'free');
  await waitProjectStatus(id, 'running');

  const result = runCli([
    'project',
    'autoscaling',
    'set',
    '--project',
    id,
    '--min',
    '1',
    '--max',
    '5',
    '--cpu',
    '1',
    '--memory',
    '1',
    '--json',
  ], { allowFail: true });

  if (result.status === 0) {
    throw new Error('Free plan unexpectedly allowed autoscaling');
  }

  evidence.push({
    scenario: 'free_plan_denied',
    id,
    status: 'passed',
    stderr: redact(result.stderr).slice(0, 180),
  });
}

async function scenarioStaticPlanChangeAndHourlyUsage() {
  const id = await createProject('hourly', 'static');
  await waitProjectStatus(id, 'running');

  const autoscaling = setAutoscaling(id, 1, 5, 1, 1);
  await generateTraffic(id);

  const scaleUp = await waitForAutoscalingEvent(
    id,
    (event) => event.direction === 'scale_up' && Number(event.new_instances) >= 2,
    'scale_up',
  );
  const basic = await changePlan(id, 'basic');
  await wait(20_000);
  const business = await changePlan(id, 'business');
  const stop = await stopProject(id);
  const usage = await waitHourlyUsage(id);

  evidence.push({
    scenario: 'static_plan_change_hourly_usage',
    id,
    autoscaling: autoscaling.state,
    scaleUp,
    basic,
    business,
    stopStatus: stop.status,
    beforeUsage: usage.before?.payload,
    finalUsage: usage.after?.payload || null,
    hourlyWaitSkipped: usage.skipped,
  });
}

async function scenarioPersistentStorage() {
  const id = await createProject('persist', 'static', httpConfig({ persistent: true, capacity: 2 }));
  await waitProjectStatus(id, 'running');

  setAutoscaling(id, 1, 5, 1, 1);
  await generateTraffic(id);

  const scaleUp = await waitForAutoscalingEvent(
    id,
    (event) => event.direction === 'scale_up' && Number(event.new_instances) >= 2,
    'scale_up_persistent',
  );
  const business = await changePlan(id, 'business');
  const stop = await stopProject(id);

  evidence.push({
    scenario: 'persistent_storage',
    id,
    scaleUp,
    business,
    stopStatus: stop.status,
  });
}

async function scenarioDisableAndManualInstances() {
  const id = await createProject('disable', 'basic');
  await waitProjectStatus(id, 'running');

  const enabled = setAutoscaling(id, 1, 4, 70, 80);
  const blockedManual = runCli([
    'project',
    'instances',
    'set',
    '--project',
    id,
    '--count',
    '2',
    '--json',
  ], { allowFail: true });

  if (blockedManual.status === 0) {
    throw new Error('Manual instance update unexpectedly succeeded while autoscaling was enabled');
  }

  const disabled = cliJson(['project', 'autoscaling', 'disable', '--project', id]);
  const manual = cliJson(['project', 'instances', 'set', '--project', id, '--count', '2']);
  const stop = await stopProject(id);

  evidence.push({
    scenario: 'disable_allows_manual_instances',
    id,
    enabled: enabled.state,
    blockedManual: redact(blockedManual.stderr).slice(0, 180),
    disabled,
    manual,
    stopStatus: stop.status,
  });
}

async function cleanup() {
  log('cleanup started', { projects: createdProjects.length });

  for (const project of createdProjects) {
    try {
      await stopProject(project.id);
    } catch (error) {
      log('cleanup stop ignored', { id: project.id, error: redact(error.message).slice(0, 180) });
    }

    try {
      const result = await deleteProject(project.id);
      log('cleanup delete', { id: project.id, status: result.status });
    } catch (error) {
      log('cleanup delete failed', { id: project.id, error: redact(error.message).slice(0, 180) });
    }
  }
}

async function verifyCleanup() {
  const results = [];

  for (const project of createdProjects) {
    const result = runCli(['project', 'info', '--project', project.id, '--json'], {
      allowFail: true,
      timeout: 60_000,
    });

    results.push({
      id: project.id,
      status: result.status,
      stdout: redact(result.stdout).slice(0, 120),
      stderr: redact(result.stderr).slice(0, 120),
    });
  }

  return results;
}

async function writeSummary(summary) {
  await mkdir(artifactDir, { recursive: true });
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  log('summary written', { summaryPath });
}

async function main() {
  let summary = null;

  try {
    log('staging autoscaling regression started', { apiBase, prefix, skipHourlyWait });

    await scenarioFreePlanDenied();
    await scenarioPersistentStorage();
    await scenarioDisableAndManualInstances();
    await scenarioStaticPlanChangeAndHourlyUsage();
  } finally {
    await cleanup();
  }

  const cleanupResults = await verifyCleanup();
  summary = {
    status: 'passed',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    apiBase,
    prefix,
    createdProjects,
    evidence,
    cleanupResults,
  };

  const cleanupFailures = cleanupResults.filter((result) => !/project dont exists/i.test(`${result.stdout}\n${result.stderr}`));
  if (cleanupFailures.length > 0) {
    summary.status = 'failed';
    summary.cleanupFailures = cleanupFailures;
    await writeSummary(summary);
    throw new Error(`Cleanup verification failed for ${cleanupFailures.length} project(s)`);
  }

  await writeSummary(summary);
}

main().catch(async (error) => {
  const failedSummary = {
    status: 'failed',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    apiBase,
    prefix,
    createdProjects,
    evidence,
    error: redact(error?.stack || error?.message || String(error)),
  };

  await writeSummary(failedSummary).catch(() => undefined);
  process.stderr.write(`${redact(error?.stack || error?.message || String(error))}\n`);
  process.exit(1);
});
