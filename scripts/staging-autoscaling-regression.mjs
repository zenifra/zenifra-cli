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
const allowMutations = process.env.ZENIFRA_STAGING_ALLOW_MUTATIONS === '1';

if (!apiKey) {
  throw new Error('Missing ZENIFRA_API_KEY_STG or ZENIFRA_API_KEY');
}

function assertSafeStagingTarget() {
  const target = new URL(apiBase);
  const hostname = target.hostname.toLowerCase();
  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(hostname);
  const isStaging = hostname.endsWith('.zenifra.com')
    && (hostname.includes('stg') || hostname.includes('staging'));

  if (hostname === 'api.zenifra.com' || (!isLocal && !isStaging)) {
    throw new Error(`Refusing mutating regression against non-staging host: ${hostname}`);
  }
  if (!allowMutations) {
    throw new Error('Set ZENIFRA_STAGING_ALLOW_MUTATIONS=1 to enable staging project creation and cleanup');
  }
}

assertSafeStagingTarget();

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
    signal: AbortSignal.timeout(30_000),
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

function httpConfig({ persistent = false, capacity = 1, autoscaling } = {}) {
  return {
    type_project: 'http',
    exposure: 'public',
    image: {
      url: 'docker.io/nginx:perl',
      is_public: true,
    },
    port: 80,
    instances: 1,
    ...(autoscaling ? { autoscaling } : {}),
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
  const deadline = Date.now() + 180_000;
  let project = null;

  while (Date.now() < deadline) {
    project = projectData(cliJson(['project', 'info', '--project', id]));
    if (project.plan === plan) {
      return {
        status: response.status,
        project,
      };
    }
    await wait(5_000);
  }

  throw new Error(`Project ${id} did not reach plan ${plan}. Last state: ${JSON.stringify(project)}`);
}

async function stopProject(id) {
  return api('PATCH', `/project/${id}/stop`, {}, [400, 404]);
}

async function deleteProject(id) {
  return api('DELETE', `/project/${id}`, undefined, [400, 404]);
}

async function hourlyUsage(id) {
  return {
    status: 200,
    payload: {
      data: cliJson(['project', 'billing', 'usage', '--project', id, '--page', '1', '--limit', '50']),
    },
  };
}

function nextClosedHourWithMargin(now = new Date()) {
  const hour = new Date(now);
  hour.setUTCMinutes(0, 0, 0);
  hour.setUTCHours(hour.getUTCHours() + 1);
  return new Date(hour.getTime() + 6 * 60 * 1000);
}

function moneyCents(value, label) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return Math.round(amount * 100);
}

function usageQuantity(value, label) {
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return quantity;
}

function validateHourlyUsage(data, { requireStorage = false } = {}) {
  const hours = Array.isArray(data?.hours) ? data.hours : [];
  const summary = data?.summary;

  if (hours.length === 0) {
    throw new Error('Hourly usage response does not contain closed hours');
  }
  if (!summary || summary.currency !== 'brl') {
    throw new Error(`Hourly usage summary has invalid currency: ${JSON.stringify(summary?.currency)}`);
  }

  let computeCents = 0;
  let storageCents = 0;
  let totalCents = 0;
  let hasComputeUsage = false;
  let hasStorageUsage = false;

  for (const hour of hours) {
    if (hour?.currency !== 'brl') {
      throw new Error(`Hourly usage row has invalid currency: ${JSON.stringify(hour?.currency)}`);
    }
    if (!['pending', 'charged'].includes(hour?.status)) {
      throw new Error(`Hourly usage row has invalid status: ${JSON.stringify(hour?.status)}`);
    }
    if (Number.isNaN(Date.parse(hour?.hour_start)) || Number.isNaN(Date.parse(hour?.hour_end))) {
      throw new Error(`Hourly usage row has invalid period: ${JSON.stringify(hour)}`);
    }

    const rowComputeCents = moneyCents(hour.compute_amount, 'hour.compute_amount');
    const rowStorageCents = moneyCents(hour.storage_amount, 'hour.storage_amount');
    const rowTotalCents = moneyCents(hour.total_amount, 'hour.total_amount');
    if (rowTotalCents !== rowComputeCents + rowStorageCents) {
      throw new Error(`Hourly usage row total does not match compute plus storage: ${JSON.stringify(hour)}`);
    }

    const instanceHours = usageQuantity(hour.compute_instance_hours, 'hour.compute_instance_hours');
    const storageGbHours = usageQuantity(hour.storage_gb_hours, 'hour.storage_gb_hours');
    hasComputeUsage ||= instanceHours > 0;
    hasStorageUsage ||= storageGbHours > 0 && rowStorageCents > 0;
    computeCents += rowComputeCents;
    storageCents += rowStorageCents;
    totalCents += rowTotalCents;
  }

  const summaryComputeCents = moneyCents(summary.compute_amount, 'summary.compute_amount');
  const summaryStorageCents = moneyCents(summary.storage_amount, 'summary.storage_amount');
  const summaryTotalCents = moneyCents(summary.total_amount, 'summary.total_amount');
  if (summaryTotalCents !== summaryComputeCents + summaryStorageCents) {
    throw new Error(`Hourly usage summary total does not match compute plus storage: ${JSON.stringify(summary)}`);
  }

  const reportedTotal = Number(data?.pagination?.total);
  if (Number.isInteger(reportedTotal) && reportedTotal === hours.length
    && (summaryComputeCents !== computeCents
      || summaryStorageCents !== storageCents
      || summaryTotalCents !== totalCents)) {
    throw new Error('Hourly usage summary does not match the returned rows');
  }
  if (!hasComputeUsage) {
    throw new Error('Hourly usage does not contain compute instance-hours');
  }
  if (requireStorage && !hasStorageUsage) {
    throw new Error('Hourly usage does not contain billable persistent storage GB-hours');
  }

  return {
    hours: hours.length,
    computeCents: summaryComputeCents,
    storageCents: summaryStorageCents,
    totalCents: summaryTotalCents,
  };
}

async function waitHourlyUsage(id, { requireStorage = false } = {}) {
  if (skipHourlyWait) {
    return {
      skipped: true,
      before: await hourlyUsage(id),
      after: null,
      validation: null,
    };
  }

  const before = await hourlyUsage(id);
  const beforeTotal = before.payload?.data?.pagination?.total || before.payload?.data?.hours?.length || 0;
  if (beforeTotal > 0) {
    return {
      skipped: false,
      before,
      after: before,
      validation: validateHourlyUsage(before.payload.data, { requireStorage }),
    };
  }

  const target = nextClosedHourWithMargin();

  log('waiting hourly usage window', {
    id,
    target: target.toISOString(),
    before_total: beforeTotal,
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
      return {
        skipped: false,
        before,
        after,
        validation: validateHourlyUsage(after.payload.data, { requireStorage }),
      };
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
  const id = await createProject('hourly', 'static', httpConfig({
    persistent: true,
    capacity: 2,
    autoscaling: {
      enabled: true,
      max_instances: 5,
      target_cpu_utilization_percent: 1,
      target_memory_utilization_percent: 1,
    },
  }));
  await waitProjectStatus(id, 'running');

  const autoscaling = cliJson(['project', 'autoscaling', '--project', id]);
  await generateTraffic(id);

  const scaleUp = await waitForAutoscalingEvent(
    id,
    (event) => event.direction === 'scale_up' && Number(event.new_instances) >= 2,
    'scale_up',
  );
  const basic = await changePlan(id, 'basic');
  const business = await changePlan(id, 'business');
  const stop = await stopProject(id);
  const usage = await waitHourlyUsage(id, { requireStorage: true });

  evidence.push({
    scenario: 'static_plan_change_hourly_usage',
    id,
    autoscaling,
    scaleUp,
    basic,
    business,
    stopStatus: stop.status,
    beforeUsage: usage.before?.payload,
    finalUsage: usage.after?.payload || null,
    hourlyWaitSkipped: usage.skipped,
    usageValidation: usage.validation,
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
  let primaryError = null;

  try {
    log('staging autoscaling regression started', { apiBase, prefix, skipHourlyWait });

    await scenarioFreePlanDenied();
    await scenarioPersistentStorage();
    await scenarioDisableAndManualInstances();
    await scenarioStaticPlanChangeAndHourlyUsage();
  } catch (error) {
    primaryError = error;
  }

  await cleanup();
  const cleanupResults = await verifyCleanup();
  const cleanupFailures = cleanupResults.filter((result) => !/project dont exists/i.test(`${result.stdout}\n${result.stderr}`));
  const summary = {
    status: primaryError || cleanupFailures.length > 0 ? 'failed' : 'passed',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    apiBase,
    prefix,
    createdProjects,
    evidence,
    cleanupResults,
    ...(primaryError ? { error: redact(primaryError?.stack || primaryError?.message || String(primaryError)) } : {}),
    ...(cleanupFailures.length > 0 ? { cleanupFailures } : {}),
  };

  await writeSummary(summary);

  if (primaryError) {
    throw primaryError;
  }
  if (cleanupFailures.length > 0) {
    throw new Error(`Cleanup verification failed for ${cleanupFailures.length} project(s)`);
  }
}

main().catch((error) => {
  process.stderr.write(`${redact(error?.stack || error?.message || String(error))}\n`);
  process.exit(1);
});
