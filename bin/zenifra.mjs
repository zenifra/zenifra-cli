#!/usr/bin/env node

import { mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import process from 'node:process';
import readline from 'node:readline/promises';

const DEFAULT_API_BASE_URL = 'https://api.zenifra.com/v1';
const SESSION_DIR = process.env.ZENIFRA_CONFIG_DIR || join(homedir(), '.config', 'zenifra-cli');
const SESSION_FILE = join(SESSION_DIR, 'session.json');
const FINAL_BUILD_STATUSES = new Set(['success', 'failed']);

class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function usage() {
  return `Zenifra CLI

Usage:
  zenifra auth login [--api-base <url>] [--code <code>]
  zenifra auth api-key --key <znf_key> [--api-base <url>]
  zenifra auth logout
  zenifra orgs [--json]
  zenifra org set [--org <id>]
  zenifra projects [--json] [--org <id>] [--type <http|postgresql|mariadb>]
  zenifra projects create --name <name> --plan <plan> --payment-mode <mode> --config <json|@file> [--description <text>] [--org <id>] [--json]
  zenifra project info --project <id> [--json]
  zenifra project url --project <id> [--json]
  zenifra project logs --project <id> [--instance <id>] [--json]
  zenifra project metrics --project <id> [--instance <id>] [--json]
  zenifra project network --project <id> [--view <summary|status-codes|routes|user-agents|request-events|source-ips>] [--json]
  zenifra project image set --project <id> --image <image> [--json]
  zenifra project envs --project <id> [--json] [--show-values]
  zenifra project env add --project <id> --name <name> --value <value> [--json]
  zenifra project env update --project <id> --name <name> --value <value> [--json]
  zenifra project env remove --project <id> --name <name> [--json]
  zenifra project instances --project <id> [--json]
  zenifra project instances set --project <id> --count <n> [--json]
  zenifra builds --project <id> [--page <n>] [--limit <n>] [--branch <name>] [--status <status>] [--json]
  zenifra deployments --project <id> [--page <n>] [--limit <n>] [--branch <name>] [--status <status>] [--json]
  zenifra deploy --project <id> [--branch <name>] [--commit-sha <sha>] [--json]
  zenifra deploy watch --project <id> --build <id> [--interval <seconds>] [--timeout <seconds>] [--json]

Environment:
  ZENIFRA_API_URL     Override API base URL.
  ZENIFRA_CONFIG_DIR  Override local session directory.
  ZENIFRA_API_KEY     Use a global organization API key for automation.
`;
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    const [rawKey, inlineValue] = arg.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_, value) => value.toUpperCase());

    if (inlineValue !== undefined) {
      flags[key] = inlineValue;
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
      continue;
    }

    flags[key] = next;
    index += 1;
  }

  return { positional, flags };
}

async function readSession() {
  if (!existsSync(SESSION_FILE)) {
    return {};
  }

  try {
    return JSON.parse(await readFile(SESSION_FILE, 'utf8'));
  } catch {
    throw new CliError(`Sessao local invalida em ${SESSION_FILE}. Rode "zenifra auth logout" e faca login novamente.`);
  }
}

async function writeSession(session) {
  await mkdir(dirname(SESSION_FILE), { recursive: true });
  await writeFile(SESSION_FILE, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
  await chmod(SESSION_FILE, 0o600).catch(() => undefined);
}

function apiBaseUrl(session, flags) {
  return String(flags.apiBase || process.env.ZENIFRA_API_URL || session.apiBaseUrl || DEFAULT_API_BASE_URL).replace(/\/$/, '');
}

function resolveCredential(session) {
  if (process.env.ZENIFRA_API_KEY) {
    return { token: process.env.ZENIFRA_API_KEY, type: 'api_key', source: 'env' };
  }

  if (session.apiKey) {
    return { token: session.apiKey, type: 'api_key', source: 'session' };
  }

  if (session.accessToken) {
    return { token: session.accessToken, type: 'user', source: 'session' };
  }

  return null;
}

function hasApiKeyCredential(session) {
  return Boolean(process.env.ZENIFRA_API_KEY || session.apiKey);
}

function requireUserSession(session, action) {
  if (session.accessToken) {
    return;
  }

  if (hasApiKeyCredential(session)) {
    throw new CliError(`${action} exige login de usuario. A API key global ja define a organizacao para comandos de automacao.`);
  }

  throw new CliError('Voce precisa fazer login primeiro: zenifra auth login');
}

async function prompt(question, defaultValue) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` (${defaultValue})` : '';
  const answer = await rl.question(`${question}${suffix}: `);
  rl.close();
  return answer.trim() || defaultValue || '';
}

async function promptHidden(question) {
  if (!process.stdin.isTTY) {
    return prompt(question);
  }

  return new Promise((resolve, reject) => {
    let value = '';
    const stdin = process.stdin;

    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stdout.write('\n');
    };

    const onData = (buffer) => {
      const char = buffer.toString('utf8');
      if (char === '\u0003') {
        cleanup();
        reject(new CliError('Operacao cancelada.', 130));
        return;
      }
      if (char === '\r' || char === '\n') {
        cleanup();
        resolve(value);
        return;
      }
      if (char === '\u007f') {
        value = value.slice(0, -1);
        return;
      }
      value += char;
    };

    process.stdout.write(`${question}: `);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function request(session, flags, method, path, { body, orgId, tokenRequired = true } = {}) {
  const credential = resolveCredential(session);
  if (tokenRequired && !credential) {
    throw new CliError('Voce precisa autenticar primeiro: zenifra auth login, zenifra auth api-key --key <znf_key> ou ZENIFRA_API_KEY.');
  }

  const headers = { Accept: 'application/json' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (credential?.token) {
    headers.Authorization = `Bearer ${credential.token}`;
  }
  if (orgId && credential?.type !== 'api_key') {
    headers['x-organization-id'] = orgId;
  }

  const response = await fetch(`${apiBaseUrl(session, flags)}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text };
    }
  }

  if (!response.ok) {
    const message = payload?.message || payload?.error || `Zenifra API retornou HTTP ${response.status}`;
    if (response.status === 401 || response.status === 403) {
      if (credential?.type === 'api_key') {
        throw new CliError(`${message}. Verifique se a API key esta ativa, possui permissao RBAC e se o IP atual esta permitido.`);
      }
      throw new CliError(`${message}. Rode "zenifra auth login" para renovar sua sessao.`);
    }
    if (String(message).includes('missing x-organization-id')) {
      throw new CliError('Organizacao nao selecionada. Rode "zenifra org set" ou use --org <id>.');
    }
    throw new CliError(message);
  }

  return payload;
}

function unwrapData(payload) {
  return payload?.data ?? payload;
}

function pickToken(payload) {
  return payload?.data?.token || payload?.data?.access_token || payload?.token || payload?.access_token;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printTable(rows, columns) {
  if (!rows.length) {
    process.stdout.write('Nenhum registro encontrado.\n');
    return;
  }

  const widths = columns.map((column) => Math.max(
    column.label.length,
    ...rows.map((row) => String(column.value(row) ?? '').length),
  ));

  process.stdout.write(`${columns.map((column, index) => column.label.padEnd(widths[index])).join('  ')}\n`);
  process.stdout.write(`${widths.map((width) => '-'.repeat(width)).join('  ')}\n`);

  for (const row of rows) {
    process.stdout.write(`${columns.map((column, index) => String(column.value(row) ?? '').padEnd(widths[index])).join('  ')}\n`);
  }
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.projects)) return value.projects;
  if (Array.isArray(value?.organizations)) return value.organizations;
  if (Array.isArray(value?.builds)) return value.builds;
  if (Array.isArray(value?.deployments)) return value.deployments;
  return [];
}

function idOf(item) {
  return item?._id || item?.id || item?.organization_id || item?.project_id || '';
}

function projectIdOf(project) {
  return project?.project_id || idOf(project);
}

function buildIdOf(build) {
  return build?.id || build?._id || build?.build_id || '';
}

function requireProjectId(flags) {
  if (!flags.project) throw new CliError('Informe --project <id>.');
  return String(flags.project);
}

function maskEnvValue(value) {
  if (value === undefined || value === null) return '';
  return '********';
}

function envsForOutput(envs, { showValues = false } = {}) {
  return asArray(envs).map((env) => ({
    ...env,
    value: showValues ? env.value : maskEnvValue(env.value),
  }));
}

function printEnvs(envs, flags) {
  const output = envsForOutput(envs, { showValues: Boolean(flags.showValues) });
  if (flags.json) return printJson(output);
  printTable(output, [
    { label: 'Nome', value: (env) => env.name || '-' },
    { label: 'Valor', value: (env) => env.value || '-' },
  ]);
}

function printProject(project) {
  const url = projectUrlOf(project);
  const rows = [
    { label: 'ID', value: projectIdOf(project) || '-' },
    { label: 'Nome', value: project.name || '-' },
    { label: 'Status', value: project.status || '-' },
    { label: 'Tipo', value: project.type_project || '-' },
    { label: 'Plano', value: project.plan || '-' },
    { label: 'URL', value: url || '-' },
    { label: 'Imagem', value: project.image || '-' },
    { label: 'Instancias', value: project.instances ?? '-' },
    { label: 'Instancias atuais', value: project.additional_info?.current_instances ?? '-' },
  ];

  for (const row of rows) {
    process.stdout.write(`${row.label}: ${row.value}\n`);
  }
}

function projectUrlOf(project) {
  const domain = project?.domain || project?.url || '';
  if (!domain) return '';
  return /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;
}

function printLogs(logs, flags) {
  if (flags.json) return printJson(logs);
  if (Array.isArray(logs)) {
    process.stdout.write(`${logs.filter(Boolean).join('\n')}\n`);
    return;
  }
  process.stdout.write(`${logs || ''}${String(logs || '').endsWith('\n') ? '' : '\n'}`);
}

async function getOrganizations(session, flags) {
  requireUserSession(session, 'Listar organizacoes');
  return asArray(unwrapData(await request(session, flags, 'GET', '/organizations')));
}

async function resolveOrgId(session, flags, { interactive = true } = {}) {
  if (hasApiKeyCredential(session)) return undefined;
  if (flags.org) return String(flags.org);
  if (session.selectedOrganizationId) return session.selectedOrganizationId;
  if (!interactive) throw new CliError('Organizacao nao selecionada. Rode "zenifra org set" ou use --org <id>.');

  const organizations = await getOrganizations(session, flags);
  if (organizations.length === 0) {
    throw new CliError('Nenhuma organizacao disponivel para este usuario.');
  }
  if (organizations.length === 1) {
    session.selectedOrganizationId = idOf(organizations[0]);
    await writeSession(session);
    return session.selectedOrganizationId;
  }

  process.stdout.write('Selecione a organizacao ativa:\n');
  organizations.forEach((org, index) => {
    process.stdout.write(`  ${index + 1}. ${org.name || org.organization?.name || idOf(org)} (${idOf(org)})\n`);
  });

  const answer = await prompt('Numero da organizacao');
  const selected = organizations[Number(answer) - 1];
  if (!selected) {
    throw new CliError('Organizacao invalida.');
  }

  session.selectedOrganizationId = idOf(selected);
  await writeSession(session);
  return session.selectedOrganizationId;
}

async function handleLogin(session, flags) {
  const email = String(flags.email || await prompt('Email'));
  const password = String(flags.password || await promptHidden('Senha'));

  const loginPayload = await request(session, flags, 'PATCH', '/authentication', {
    tokenRequired: false,
    body: { email, password },
  });

  let payload = loginPayload;
  const directToken = pickToken(loginPayload);

  if (!directToken) {
    const loginData = unwrapData(loginPayload);

    if (!loginData?.requires_challenge) {
      throw new CliError('Login nao retornou token nem desafio de autenticacao.');
    }

    const challengeToken = String(flags.challengeToken || loginData.challenge_token || '');
    if (!challengeToken) {
      throw new CliError('Login exigiu desafio, mas a API nao retornou challenge_token.');
    }

    const challengeType = loginData.challenge_type || 'email_code';
    const destination = loginData.masked_destination ? ` (${loginData.masked_destination})` : '';
    const label = challengeType === 'totp_app'
      ? 'Codigo do app autenticador'
      : `Codigo de verificacao${destination}`;
    const code = String(flags.code || flags.totp || await prompt(label));

    payload = await request(session, flags, 'POST', '/authentication/challenge/verify', {
      tokenRequired: false,
      body: {
        challenge_token: challengeToken,
        code,
      },
    });
  }

  const accessToken = pickToken(payload);
  if (!accessToken) {
    throw new CliError('Login concluido sem token na resposta. Verifique o contrato de /authentication/challenge/verify.');
  }

  const nextSession = {
    ...session,
    accessToken,
    apiKey: undefined,
    apiBaseUrl: apiBaseUrl(session, flags),
    selectedOrganizationId: session.selectedOrganizationId,
    updatedAt: new Date().toISOString(),
  };

  await writeSession(nextSession);
  process.stdout.write('Login realizado com sucesso.\n');
}

async function handleApiKeyLogin(session, flags) {
  const apiKey = String(flags.key || await promptHidden('API key Zenifra'));

  if (!apiKey.startsWith('znf_')) {
    throw new CliError('API key invalida. As API keys globais da Zenifra comecam com "znf_".');
  }

  const nextSession = {
    ...session,
    accessToken: undefined,
    selectedOrganizationId: undefined,
    apiKey,
    apiBaseUrl: apiBaseUrl(session, flags),
    updatedAt: new Date().toISOString(),
  };

  await writeSession(nextSession);
  process.stdout.write('API key salva com sucesso. Ela sera usada em comandos de automacao.\n');
}

async function handleLogout() {
  await rm(SESSION_FILE, { force: true });
  process.stdout.write('Sessao removida.\n');
}

async function handleOrgs(session, flags) {
  const organizations = await getOrganizations(session, flags);
  if (flags.json) return printJson(organizations);
  printTable(organizations, [
    { label: 'ID', value: idOf },
    { label: 'Nome', value: (org) => org.name || org.organization?.name || '-' },
    { label: 'Role', value: (org) => org.role || '-' },
    { label: 'Status', value: (org) => org.status || '-' },
  ]);
}

async function handleOrgSet(session, flags) {
  requireUserSession(session, 'Selecionar organizacao');

  if (flags.org) {
    session.selectedOrganizationId = String(flags.org);
    await writeSession(session);
    process.stdout.write(`Organizacao ativa: ${session.selectedOrganizationId}\n`);
    return;
  }

  const orgId = await resolveOrgId({ ...session, selectedOrganizationId: undefined }, flags, { interactive: true });
  process.stdout.write(`Organizacao ativa: ${orgId}\n`);
}

async function handleProjects(session, flags) {
  const orgId = await resolveOrgId(session, flags);
  const query = buildQuery(flags, ['type']);
  const data = unwrapData(await request(session, flags, 'GET', `/project${query}`, { orgId }));
  const projects = asArray(data);

  if (flags.json) return printJson(data);
  printTable(projects, [
    { label: 'ID', value: projectIdOf },
    { label: 'Nome', value: (project) => project.name || '-' },
    { label: 'Status', value: (project) => project.status || '-' },
    { label: 'Plano', value: (project) => project.plan || '-' },
    { label: 'Tipo', value: (project) => project.type_project || project.config?.type_project || '-' },
  ]);
}

async function parseConfig(input) {
  if (!input) {
    throw new CliError('Informe --config com JSON ou @arquivo.json.');
  }
  const raw = String(input).startsWith('@')
    ? await readFile(String(input).slice(1), 'utf8')
    : String(input);

  try {
    return JSON.parse(raw);
  } catch {
    throw new CliError('Config invalido. Use JSON valido ou @arquivo.json.');
  }
}

async function handleProjectCreate(session, flags) {
  const orgId = await resolveOrgId(session, flags);
  const name = flags.name || await prompt('Nome do projeto');
  const plan = flags.plan || await prompt('Plano', 'free');
  const paymentMode = flags.paymentMode || await prompt('Modo de pagamento', 'hourly');
  const config = await parseConfig(flags.config || await prompt('Config JSON ou @arquivo'));

  const payload = await request(session, flags, 'POST', '/project', {
    orgId,
    body: {
      name,
      ...(flags.description ? { description: String(flags.description) } : {}),
      plan,
      payment_mode: paymentMode,
      config,
    },
  });

  if (flags.json) return printJson(payload);
  const project = unwrapData(payload);
  process.stdout.write(`Projeto criado: ${projectIdOf(project) || 'id indisponivel'}\n`);
  if (project.domain) process.stdout.write(`Dominio: ${project.domain}\n`);
  if (project.api_key) process.stdout.write(`API key: ${project.api_key}\n`);
}

async function getProject(session, flags, projectId, orgId) {
  return unwrapData(await request(session, flags, 'GET', `/project/${projectId}`, { orgId }));
}

async function handleProjectInfo(session, flags) {
  const projectId = requireProjectId(flags);
  const orgId = await resolveOrgId(session, flags);
  const project = await getProject(session, flags, projectId, orgId);

  if (flags.json) return printJson(project);
  printProject({ ...project, id: projectId });
}

async function handleProjectUrl(session, flags) {
  const projectId = requireProjectId(flags);
  const orgId = await resolveOrgId(session, flags);
  const project = await getProject(session, flags, projectId, orgId);
  const url = projectUrlOf(project);
  const payload = {
    project_id: projectId,
    url,
    domain: project.domain || null,
    custom_domains: project.custom_domains || [],
  };

  if (flags.json) return printJson(payload);
  if (!url) throw new CliError('Projeto nao possui URL disponivel.');
  process.stdout.write(`${url}\n`);
}

async function handleProjectLogs(session, flags) {
  const projectId = requireProjectId(flags);
  const orgId = await resolveOrgId(session, flags);
  const query = buildQuery(flags, ['instance']);
  const logs = unwrapData(await request(session, flags, 'GET', `/project/${projectId}/logs${query}`, { orgId }));

  printLogs(logs, flags);
}

async function handleProjectMetrics(session, flags) {
  const projectId = requireProjectId(flags);
  const orgId = await resolveOrgId(session, flags);
  const query = buildQuery(flags, ['instance']);
  const metrics = unwrapData(await request(session, flags, 'GET', `/project/${projectId}/metrics${query}`, { orgId }));

  if (flags.json) return printJson(metrics);
  if (Array.isArray(metrics)) {
    return printTable(metrics, [
      { label: 'Instancia', value: (metric) => metric.instance || '-' },
      { label: 'Tipo', value: (metric) => metric.type || '-' },
      { label: 'CPU', value: (metric) => metric.cpu ?? '-' },
      { label: 'Memoria', value: (metric) => metric.memory ?? '-' },
    ]);
  }
  printJson(metrics);
}

async function handleProjectNetwork(session, flags) {
  const projectId = requireProjectId(flags);
  const orgId = await resolveOrgId(session, flags);
  const view = String(flags.view || 'summary');
  const allowedViews = new Set(['summary', 'status-codes', 'routes', 'user-agents', 'request-events', 'source-ips']);

  if (!allowedViews.has(view)) {
    throw new CliError('View de rede invalida. Use summary, status-codes, routes, user-agents, request-events ou source-ips.');
  }

  const data = unwrapData(await request(session, flags, 'GET', `/project/${projectId}/metrics/network/${view}`, { orgId }));
  if (flags.json) return printJson(data);
  printJson(data);
}

async function handleProjectImageSet(session, flags) {
  const projectId = requireProjectId(flags);
  const image = flags.image || await prompt('Imagem');
  if (!image) throw new CliError('Informe --image <image>.');

  const orgId = await resolveOrgId(session, flags);
  const payload = await request(session, flags, 'PATCH', `/project/${projectId}/image`, {
    orgId,
    body: { image: String(image) },
  });

  if (flags.json) return printJson(payload);
  process.stdout.write('Imagem atualizada com sucesso.\n');
}

async function getProjectEnvs(session, flags, projectId, orgId) {
  return asArray(unwrapData(await request(session, flags, 'GET', `/project/${projectId}/envs`, { orgId })));
}

async function patchProjectEnvs(session, flags, projectId, orgId, envs) {
  return request(session, flags, 'PATCH', `/project/${projectId}/envs`, {
    orgId,
    body: { envs },
  });
}

async function handleProjectEnvs(session, flags) {
  const projectId = requireProjectId(flags);
  const orgId = await resolveOrgId(session, flags);
  const envs = await getProjectEnvs(session, flags, projectId, orgId);

  printEnvs(envs, flags);
}

async function handleProjectEnvMutation(session, flags, action) {
  const projectId = requireProjectId(flags);
  const name = String(flags.name || '').trim();
  if (!name) throw new CliError('Informe --name <name>.');

  const needsValue = action === 'add' || action === 'update';
  const value = needsValue ? String(flags.value ?? await promptHidden('Valor')) : undefined;
  if (needsValue && !value) throw new CliError('Informe --value <value>.');

  const orgId = await resolveOrgId(session, flags);
  const envs = await getProjectEnvs(session, flags, projectId, orgId);
  const existingIndex = envs.findIndex((env) => env.name === name);

  if (action === 'add' && existingIndex !== -1) {
    throw new CliError(`Env ${name} ja existe. Use "zenifra project env update".`);
  }

  if ((action === 'update' || action === 'remove') && existingIndex === -1) {
    throw new CliError(`Env ${name} nao existe.`);
  }

  const nextEnvs = [...envs];
  if (action === 'add') nextEnvs.push({ name, value });
  if (action === 'update') nextEnvs[existingIndex] = { ...nextEnvs[existingIndex], name, value };
  if (action === 'remove') nextEnvs.splice(existingIndex, 1);

  const payload = await patchProjectEnvs(session, flags, projectId, orgId, nextEnvs);

  if (flags.json) {
    return printJson({
      status: payload.status || 'success',
      message: payload.message || 'updated with success',
      envs: envsForOutput(nextEnvs),
    });
  }

  process.stdout.write(`Env ${name} ${action === 'remove' ? 'removida' : 'atualizada'} com sucesso.\n`);
}

async function handleProjectInstances(session, flags) {
  const projectId = requireProjectId(flags);
  const orgId = await resolveOrgId(session, flags);
  const instances = unwrapData(await request(session, flags, 'GET', `/project/${projectId}/instances`, { orgId }));

  if (flags.json) return printJson(instances);
  printTable(asArray(instances), [
    { label: 'Instancia', value: (instance) => instance.instance || instance.name || '-' },
  ]);
}

async function handleProjectInstancesSet(session, flags) {
  const projectId = requireProjectId(flags);
  const instances = Number(flags.count);
  if (!Number.isInteger(instances) || instances <= 0) {
    throw new CliError('Informe --count <n> com um inteiro positivo.');
  }

  const orgId = await resolveOrgId(session, flags);
  const payload = await request(session, flags, 'PATCH', `/project/${projectId}/instances`, {
    orgId,
    body: { instances },
  });

  if (flags.json) return printJson(payload);
  process.stdout.write(`Quantidade de instancias atualizada para ${instances}.\n`);
}

function buildQuery(flags, allowedKeys) {
  const params = new URLSearchParams();
  for (const key of allowedKeys) {
    if (flags[key] !== undefined && flags[key] !== true) {
      const apiKey = key.replace(/[A-Z]/g, (value) => `_${value.toLowerCase()}`);
      params.set(apiKey, String(flags[key]));
    }
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

async function handleDeployments(session, flags) {
  const projectId = flags.project;
  if (!projectId) throw new CliError('Informe --project <id>.');
  const orgId = await resolveOrgId(session, flags);
  const query = buildQuery(flags, ['page', 'limit', 'branch', 'status']);
  const data = unwrapData(await request(session, flags, 'GET', `/project/${projectId}/github/builds${query}`, { orgId }));
  const builds = asArray(data);

  if (flags.json) return printJson(data);
  printTable(builds, [
    { label: 'Build', value: (build) => buildIdOf(build) || '-' },
    { label: 'Status', value: (build) => build.status || '-' },
    { label: 'Branch', value: (build) => build.branch || '-' },
    { label: 'Commit', value: (build) => build.commit_sha || '-' },
    { label: 'Inicio', value: (build) => build.started_at || build.created_at || '-' },
  ]);
}

async function handleDeploy(session, flags) {
  const projectId = flags.project;
  if (!projectId) throw new CliError('Informe --project <id>.');
  const orgId = await resolveOrgId(session, flags);
  const body = {};
  if (flags.branch) body.branch = String(flags.branch);
  if (flags.commitSha) body.commit_sha = String(flags.commitSha);

  const payload = await request(session, flags, 'POST', `/project/${projectId}/github/deploy`, {
    orgId,
    body,
  });

  if (flags.json) return printJson(payload);
  const buildId = unwrapData(payload)?.build_id || payload?.build_id || unwrapData(payload)?.id;
  process.stdout.write(`Deploy iniciado${buildId ? `: ${buildId}` : '.'}\n`);
}

async function getBuild(session, flags, projectId, buildId, orgId) {
  return unwrapData(await request(session, flags, 'GET', `/project/${projectId}/github/builds/${buildId}`, { orgId }));
}

async function handleDeployWatch(session, flags) {
  const projectId = flags.project;
  const buildId = flags.build;
  if (!projectId) throw new CliError('Informe --project <id>.');
  if (!buildId) throw new CliError('Informe --build <id>.');

  const orgId = await resolveOrgId(session, flags);
  const intervalMs = Math.max(Number(flags.interval || 5), 1) * 1000;
  const timeoutMs = Math.max(Number(flags.timeout || 900), 1) * 1000;
  const startedAt = Date.now();

  while (true) {
    const build = await getBuild(session, flags, projectId, buildId, orgId);
    const status = build?.status || 'unknown';

    if (flags.json) {
      printJson(build);
    } else {
      process.stdout.write(`[${new Date().toISOString()}] build ${buildId}: ${status}\n`);
    }

    if (FINAL_BUILD_STATUSES.has(status)) {
      if (status === 'failed') {
        process.exitCode = 1;
      }
      return;
    }

    if (Date.now() - startedAt > timeoutMs) {
      throw new CliError(`Timeout aguardando build ${buildId}. Ultimo status: ${status}`);
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, subcommand] = positional;
  const session = await readSession();

  if (!command || flags.help || command === 'help') {
    process.stdout.write(usage());
    return;
  }

  if (command === 'auth' && subcommand === 'login') return handleLogin(session, flags);
  if (command === 'auth' && subcommand === 'api-key') return handleApiKeyLogin(session, flags);
  if (command === 'auth' && subcommand === 'logout') return handleLogout();
  if (command === 'login') return handleLogin(session, flags);
  if (command === 'logout') return handleLogout();
  if (command === 'orgs') return handleOrgs(session, flags);
  if (command === 'org' && subcommand === 'set') return handleOrgSet(session, flags);
  if (command === 'projects' && subcommand === 'create') return handleProjectCreate(session, flags);
  if (command === 'projects') return handleProjects(session, flags);
  if (command === 'project' && subcommand === 'info') return handleProjectInfo(session, flags);
  if (command === 'project' && subcommand === 'url') return handleProjectUrl(session, flags);
  if (command === 'project' && subcommand === 'logs') return handleProjectLogs(session, flags);
  if (command === 'project' && subcommand === 'metrics') return handleProjectMetrics(session, flags);
  if (command === 'project' && subcommand === 'network') return handleProjectNetwork(session, flags);
  if (command === 'project' && subcommand === 'image' && positional[2] === 'set') return handleProjectImageSet(session, flags);
  if (command === 'project' && subcommand === 'envs') return handleProjectEnvs(session, flags);
  if (command === 'project' && subcommand === 'env' && positional[2] === 'add') return handleProjectEnvMutation(session, flags, 'add');
  if (command === 'project' && subcommand === 'env' && positional[2] === 'update') return handleProjectEnvMutation(session, flags, 'update');
  if (command === 'project' && subcommand === 'env' && positional[2] === 'remove') return handleProjectEnvMutation(session, flags, 'remove');
  if (command === 'project' && subcommand === 'instances' && positional[2] === 'set') return handleProjectInstancesSet(session, flags);
  if (command === 'project' && subcommand === 'instances') return handleProjectInstances(session, flags);
  if (command === 'builds') return handleDeployments(session, flags);
  if (command === 'deployments') return handleDeployments(session, flags);
  if (command === 'deploy' && subcommand === 'watch') return handleDeployWatch(session, flags);
  if (command === 'deploy') return handleDeploy(session, flags);

  throw new CliError(`Comando desconhecido: ${positional.join(' ')}`);
}

main().catch((error) => {
  if (error instanceof CliError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(error.exitCode);
  }

  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
