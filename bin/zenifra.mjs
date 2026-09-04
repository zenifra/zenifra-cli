#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import process from 'node:process';
import readline from 'node:readline/promises';

const DEFAULT_API_BASE_URL = 'https://api.zenifra.com/v1';
const DOCS_BASE_URL = 'https://docs.zenifra.com/pt';
const DOCS_RUNTIME_URL = `${DOCS_BASE_URL}/docs/runtime`;
const DOCS_CREATE_HTTP_URL = `${DOCS_BASE_URL}/docs/how-use-zenifra/http/how-to-create-a-http-project-at-zenifra-via-console`;
const DOCS_CREATE_POSTGRESQL_URL = `${DOCS_BASE_URL}/docs/how-use-zenifra/database/how-to-create-a-postgresql-project-at-zenifra-via-console`;
const DOCS_CREATE_MARIADB_URL = `${DOCS_BASE_URL}/docs/how-use-zenifra/database/how-to-create-a-mariadb-project-at-zenifra-via-console`;
const DOCS_CREATE_VALKEY_URL = `${DOCS_BASE_URL}/docs/managed-services/valkey`;
const DOCS_CONFIGURATION_URL = `${DOCS_BASE_URL}/docs/configuration`;
const DOCS_DATABASE_CONFIGURATION_URL = `${DOCS_BASE_URL}/docs/database/configuration/configuration`;
const DOCS_PAYMENTS_URL = `${DOCS_BASE_URL}/docs/payments/payments`;
const SESSION_DIR = process.env.ZENIFRA_CONFIG_DIR || join(homedir(), '.config', 'zenifra-cli');
const SESSION_FILE = join(SESSION_DIR, 'session.json');
const PROFILES_FILE = join(SESSION_DIR, 'profiles.json');
const PROFILE_STORE_VERSION = 1;
const DEFAULT_PROFILE_NAME = 'default';
const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
const OCI_IMAGE_REFERENCE_PATTERN = /^[a-z0-9._-]+\/(?:[a-z0-9._-]+\/)*[a-z0-9._-]+(?::[a-z0-9._-]+|@sha256:[a-f0-9]{64})$/;
const OCI_IMAGE_REFERENCE_MIN_LENGTH = 8;
const OCI_IMAGE_REFERENCE_MAX_LENGTH = 256;
const KNOWN_FLAG_NAMES = new Set([
  'apiBase',
  'branch',
  'build',
  'challengeToken',
  'code',
  'commitSha',
  'config',
  'count',
  'cpu',
  'cursor',
  'description',
  'direction',
  'email',
  'exposure',
  'follow',
  'from',
  'help',
  'image',
  'idempotencyKey',
  'instance',
  'interval',
  'json',
  'key',
  'limit',
  'max',
  'memory',
  'min',
  'mode',
  'name',
  'org',
  'operation',
  'page',
  'password',
  'path',
  'paymentMode',
  'plan',
  'profile',
  'project',
  'revoke',
  'run',
  'runId',
  'showValues',
  'status',
  'timeout',
  'to',
  'totp',
  'type',
  'value',
  'view',
  'wait',
]);
const ALLOWED_PLAN_VALUES = new Set([
  'free',
  'static',
  'basic',
  'premium',
  'premium_plus',
  'business',
  'deep_learning_basic',
  'deep_learning_premium',
  'db-free',
  'db-starter',
  'db-basic',
  'db-premium',
  'db-enterprise',
  'cache-free',
  'cache-starter',
  'cache-basic',
  'cache-premium',
  'cache-enterprise',
  'queue-free',
  'queue-starter',
  'queue-basic',
  'queue-premium',
  'queue-enterprise',
]);
const ALLOWED_PAYMENT_MODE_VALUES = new Set(['hourly', 'monthly', 'yearly', 'per_minute']);
const ALLOWED_TYPE_PROJECT_VALUES = new Set(['http', 'postgresql', 'mariadb', 'valkey', 'job']);
const ALLOWED_RUNTIME_VALUES = new Set(['nodejs', 'python']);
const ALLOWED_EXPOSURE_VALUES = new Set(['public', 'private']);
const GITHUB_RUNTIME_VERSIONS = {
  nodejs: ['24', '22', '20'],
  python: ['3.13', '3.12', '3.11'],
};
const ALLOWED_POSTGRESQL_VERSIONS = ['15', '16', '17', '18'];
const ALLOWED_MARIADB_VERSIONS = ['10', '11'];
const DEFAULT_HTTP_NETWORK_ACCESS = {
  ingress_white_list: [{ cidr: '0.0.0.0/0', description: 'Allow all' }],
  ingress_black_list: [],
};
const WIZARD_HTTP_PLAN_OPTIONS = [
  'free',
  'static',
  'basic',
  'premium',
  'premium_plus',
  'business',
  'deep_learning_basic',
  'deep_learning_premium',
];
const WIZARD_DATABASE_PLAN_OPTIONS = [
  'db-basic',
  'db-premium',
  'db-starter',
  'db-enterprise',
  'db-free',
];
const WIZARD_PAYMENT_MODE_OPTIONS = ['hourly', 'monthly', 'yearly'];
const WIZARD_JOB_PLAN_OPTIONS = WIZARD_HTTP_PLAN_OPTIONS;
const WIZARD_TYPE_PROJECT_OPTIONS = ['http', 'postgresql', 'mariadb', 'valkey'];
const WIZARD_VALKEY_PROFILE_OPTIONS = ['key_value', 'cache', 'queue'];
const WIZARD_HTTP_EXPOSURE_OPTIONS = ['public', 'private'];
let promptInterface;
let pipedInputPromise;
let pipedInputIndex = 0;
const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  cyan: '\u001b[36m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
};

class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function usage() {
  return `Zenifra CLI

Usage:
  zenifra help <command>
  zenifra auth login [--profile <name>] [--api-base <url>] [--code <code>]
  zenifra auth api-key --key <znf_key> [--profile <name>] [--api-base <url>]
  zenifra auth logout [--profile <name>] [--revoke]
  zenifra profile list [--json]
  zenifra profile show [<name>] [--json]
  zenifra profile add [--name <name>] [--description <text>] [--api-base <url>] [--mode <api-key|login>] [--key <znf_key>] [--json]
  zenifra profile edit <name> [--description <text>] [--api-base <url>] [--json]
  zenifra profile use <name> [--json]
  zenifra profile remove <name> [--json]
  zenifra orgs [--json]
  zenifra org set [--org <id>]
  zenifra plans [--type <all|http|database|storage|valkey|job>] [--json]
  zenifra create project
  zenifra create project --name <name> --plan <plan> [--payment-mode <mode>] --config <json|@file> [--description <text>] [--org <id>] [--json]
  zenifra projects [--json] [--org <id>] [--type <http|postgresql|mariadb|valkey|job>] [--page <n>] [--limit <n>]
  zenifra valkey status --project <id> [--json]
  zenifra valkey connection --project <id> [--json]
  zenifra valkey credentials rotate --project <id> [--idempotency-key <key>] [--wait] [--interval <seconds>] [--timeout <seconds>] [--json]
  zenifra valkey credentials status --project <id> --operation <id> [--json]
  zenifra project info --project <id> [--json]
  zenifra project url --project <id> [--json]
  zenifra project logs --project <id> [--instance <id>] [--json]
  zenifra project runs --project <id> [--page <n>] [--limit <n>] [--json]
  zenifra project runs cancel --project <id> --run <id> [--json]
  zenifra project runs logs --project <id> --run <id> [--json]
  zenifra project metrics --project <id> [--instance <id>] [--json]
  zenifra project metrics capabilities --project <id> [--json]
  zenifra project healthcheck get --project <id> [--json]
  zenifra project healthcheck set --project <id> --path /health [--json]
  zenifra project healthcheck disable --project <id> [--json]
  zenifra project healthcheck failures --project <id> [--page <n>] [--limit <n>] [--json]
  zenifra project network --project <id> [--view <summary|status-codes|routes|user-agents|request-events|source-ips>] [--json]
  zenifra project image set --project <id> --image <image> [--json]
  zenifra project exposure set --project <id> --exposure <public|private> [--json]
  zenifra project envs --project <id> [--json] [--show-values]
  zenifra project env add --project <id> --name <name> --value <value> [--json]
  zenifra project env update --project <id> --name <name> --value <value> [--json]
  zenifra project env remove --project <id> --name <name> [--json]
  zenifra project autoscaling --project <id> [--json]
  zenifra project autoscaling set --project <id> --min <n> --max <n> [--cpu <percent>] [--memory <percent>] [--json]
  zenifra project autoscaling disable --project <id> [--json]
  zenifra project autoscaling events --project <id> [--direction <scale_up|scale_down>] [--from <iso>] [--to <iso>] [--page <n>] [--limit <n>] [--json]
  zenifra project billing usage --project <id> [--from <iso>] [--to <iso>] [--page <n>] [--limit <n>] [--json]
  zenifra project instances --project <id> [--json]
  zenifra project instances set --project <id> --count <n> [--json]
  zenifra builds --project <id> [--page <n>] [--limit <n>] [--branch <name>] [--status <status>] [--json]
  zenifra builds logs --project <id> --build <id> [--cursor <n>] [--limit <n>] [--follow] [--interval <seconds>] [--timeout <seconds>] [--json]
  zenifra deployments --project <id> [--page <n>] [--limit <n>] [--branch <name>] [--status <status>] [--json]
  zenifra deploy --project <id> [--branch <name>] [--commit-sha <sha>] [--json]
  zenifra deploy watch --project <id> --build <id> [--interval <seconds>] [--timeout <seconds>] [--json]

Environment:
  ZENIFRA_API_URL     Override API base URL.
  ZENIFRA_CONFIG_DIR  Override local profile directory.
  ZENIFRA_API_KEY     Use a global organization API key for automation.

Run "zenifra help <command>" or "zenifra <command> --help" for command-specific usage, examples, and output.
`;
}

const HELP_SPECS = [
  {
    command: 'auth',
    usage: 'zenifra auth\n  zenifra auth login [--profile <name>] [--api-base <url>] [--code <code>]\n  zenifra auth api-key --key <znf_key> [--profile <name>] [--api-base <url>]\n  zenifra auth logout [--profile <name>] [--revoke]',
    description: 'Gerencia a autenticacao dos perfis locais da CLI.',
    examples: ['zenifra auth', 'zenifra auth login --profile staging', 'zenifra auth api-key --profile prod --key znf_0123456789abcdef01234567_abcd...'],
    output: 'Zenifra CLI - auth',
    notes: ['Use "zenifra help auth login", "zenifra help auth api-key" ou "zenifra help auth logout" para detalhes de cada subcomando.'],
  },
  {
    command: 'auth login',
    usage: 'zenifra auth login [--profile <name>] [--api-base <url>] [--code <code>]',
    description: 'Autentica um usuario Zenifra no perfil ativo ou em um perfil especifico.',
    flags: [
      '--profile <name>  Atualiza ou cria o perfil informado e o torna ativo.',
      '--api-base <url>  Usa uma API diferente da producao.',
      '--code <code>     Informa o codigo de desafio sem prompt interativo.',
    ],
    examples: ['zenifra auth login', 'zenifra auth login --profile staging --code 123456'],
    output: 'Login realizado com sucesso.',
    notes: ['Exige email, senha e, quando habilitado, codigo de desafio.'],
  },
  {
    command: 'auth api-key',
    usage: 'zenifra auth api-key --key <znf_key> [--profile <name>] [--api-base <url>]',
    description: 'Salva uma API key organizacional no perfil ativo ou em um perfil especifico.',
    flags: ['--key <znf_key>      API key organizacional.', '--profile <name>  Atualiza ou cria o perfil informado e o torna ativo.', '--api-base <url>   Usa uma API diferente da producao.'],
    examples: ['zenifra auth api-key --key znf_0123456789abcdef01234567_abcd...', 'zenifra auth api-key --profile prod --key znf_0123456789abcdef01234567_abcd...'],
    output: 'API key salva com sucesso. Ela sera usada em comandos de automacao.',
    notes: ['API keys ja carregam a organizacao e nao exigem "zenifra org set".'],
  },
  {
    command: 'auth logout',
    usage: 'zenifra auth logout [--profile <name>] [--revoke]',
    description: 'Remove a autenticacao do perfil ativo ou do perfil informado.',
    flags: ['--profile <name>  Limpa outro perfil sem trocar o perfil ativo.', '--revoke          Revoga as sessoes de usuario no servidor antes de limpar o perfil.'],
    examples: ['zenifra auth logout', 'zenifra auth logout --profile staging', 'zenifra auth logout --revoke'],
    output: 'Autenticacao removida do perfil active.',
    notes: ['Sem --revoke, remove somente a credencial local. A revogacao invalida as sessoes de login do usuario e nao se aplica a API keys.'],
  },
  {
    command: 'profile',
    usage: 'zenifra profile\n  zenifra profile list [--json]\n  zenifra profile show [<name>] [--json]\n  zenifra profile add [--name <name>] [--description <text>] [--api-base <url>] [--mode <api-key|login>] [--key <znf_key>] [--json]\n  zenifra profile edit <name> [--description <text>] [--api-base <url>] [--json]\n  zenifra profile use <name> [--json]\n  zenifra profile remove <name> [--json]',
    description: 'Gerencia perfis de ambiente locais, incluindo API base, descricao e credenciais.',
    examples: ['zenifra profile', 'zenifra profile list', 'zenifra profile add --name staging --description Homologacao --api-base https://api-stg.zenifra.com/v1 --mode api-key --key znf_0123...'],
    output: 'Zenifra CLI - profile',
    notes: ['Use "zenifra help profile <subcomando>" para detalhes de list, show, add, edit, use e remove.'],
  },
  {
    command: 'profile list',
    usage: 'zenifra profile list [--json]',
    description: 'Lista os perfis locais configurados e indica o perfil ativo.',
    flags: ['--json  Imprime a resposta em JSON.'],
    examples: ['zenifra profile list', 'zenifra profile list --json'],
    output: 'Nome      Tipo         API base                      Ativo  Descricao\nprod      api_key      https://api.zenifra.com/v1    yes    Producao\nstaging   access_token https://api-stg.zenifra.com/v1 no     Homologacao',
    jsonOutput: '[{"name":"prod","auth_mode":"api_key","api_base_url":"https://api.zenifra.com/v1","active":true}]',
  },
  {
    command: 'profile show',
    usage: 'zenifra profile show [<name>] [--json]',
    description: 'Mostra os detalhes do perfil ativo ou de um perfil especifico.',
    flags: ['--json  Imprime a resposta em JSON.'],
    examples: ['zenifra profile show', 'zenifra profile show staging --json'],
    output: 'Nome: prod\nDescricao: Producao\nTipo: api_key\nAPI base: https://api.zenifra.com/v1\nAPI key: znf_0123...FGHI',
    jsonOutput: '{"name":"prod","description":"Producao","auth_mode":"api_key","api_base_url":"https://api.zenifra.com/v1","active":true}',
  },
  {
    command: 'profile add',
    usage: 'zenifra profile add [--name <name>] [--description <text>] [--api-base <url>] [--mode <api-key|login>] [--key <znf_key>] [--json]',
    description: 'Cria um novo perfil e opcionalmente autentica via API key ou login de usuario.',
    flags: ['--name <name>          Nome do perfil.', '--description <text>   Descricao opcional.', '--api-base <url>       API base do perfil.', '--mode <mode>          api-key ou login.', '--key <znf_key>        API key para modo api-key.', '--json                 Imprime a resposta em JSON.'],
    examples: ['zenifra profile add --name staging --description Homologacao --api-base https://api-stg.zenifra.com/v1 --mode api-key --key znf_0123...', 'zenifra profile add'],
    output: 'Perfil staging salvo e definido como ativo.',
    jsonOutput: '{"name":"staging","auth_mode":"api_key","active":true}',
  },
  {
    command: 'profile edit',
    usage: 'zenifra profile edit <name> [--description <text>] [--api-base <url>] [--json]',
    description: 'Atualiza descricao e API base de um perfil existente.',
    flags: ['--description <text>  Nova descricao.', '--api-base <url>      Nova API base.', '--json                Imprime a resposta em JSON.'],
    examples: ['zenifra profile edit staging --description Homologacao interna', 'zenifra profile edit prod --api-base https://api.zenifra.com/v1 --json'],
    output: 'Perfil staging atualizado.',
    jsonOutput: '{"name":"staging","description":"Homologacao interna"}',
  },
  {
    command: 'profile use',
    usage: 'zenifra profile use <name> [--json]',
    description: 'Define o perfil ativo para os proximos comandos.',
    flags: ['--json  Imprime a resposta em JSON.'],
    examples: ['zenifra profile use staging', 'zenifra profile use prod --json'],
    output: 'Perfil ativo: staging',
    jsonOutput: '{"active_profile":"staging"}',
  },
  {
    command: 'profile remove',
    usage: 'zenifra profile remove <name> [--json]',
    description: 'Remove um perfil local que nao esteja ativo.',
    flags: ['--json  Imprime a resposta em JSON.'],
    examples: ['zenifra profile remove staging'],
    output: 'Perfil staging removido.',
    jsonOutput: '{"removed":"staging"}',
  },
  {
    command: 'org',
    usage: 'zenifra org\n  zenifra org set [--org <id>]',
    description: 'Agrupa comandos relacionados a organizacao ativa da sessao de usuario.',
    examples: ['zenifra org', 'zenifra org set', 'zenifra org set --org 507f1f77bcf86cd799439011'],
    output: 'Zenifra CLI - org',
    notes: ['Use "zenifra help org set" para detalhes do seletor de organizacao.'],
  },
  {
    command: 'orgs',
    usage: 'zenifra orgs [--json]',
    description: 'Lista organizacoes disponiveis para o usuario autenticado.',
    flags: ['--json  Imprime a resposta em JSON.'],
    examples: ['zenifra orgs', 'zenifra orgs --json'],
    output: 'ID                        Nome        Role   Status\n507f1f77bcf86cd799439011  Minha org   owner  active',
    jsonOutput: '[{"_id":"507f1f77bcf86cd799439011","name":"Minha org","role":"owner","status":"active"}]',
  },
  {
    command: 'org set',
    usage: 'zenifra org set [--org <id>]',
    description: 'Seleciona a organizacao ativa para comandos com sessao de usuario.',
    flags: ['--org <id>  Define a organizacao sem prompt interativo.'],
    examples: ['zenifra org set', 'zenifra org set --org 507f1f77bcf86cd799439011'],
    output: 'Organizacao ativa: 507f1f77bcf86cd799439011',
  },
  {
    command: 'plans',
    usage: 'zenifra plans [--type <all|http|database|storage|valkey>] [--json]',
    description: 'Lista os catalogos publicos de preco de planos HTTP, banco, armazenamento, Valkey e Jobs agendados.',
    flags: ['--type <type>  Filtra o catalogo: all, http, database, storage, valkey, job, key-value, cache ou queue.', '--json         Imprime a resposta em JSON.'],
    examples: ['zenifra plans', 'zenifra plans --type http', 'zenifra plans --type job --json'],
    output: 'Jobs agendados\nPlano       Por minuto  Features\nbasic   R$ 0,02      500m CPU, 512Mi memory',
    jsonOutput: '{"http":[],"database":[],"storage":[],"job":[{"plan":"basic","payment_mode":"per_minute","unit_amount":2}]}',
  },
  {
    command: 'valkey',
    usage: 'zenifra valkey\n  zenifra valkey status --project <id> [--json]\n  zenifra valkey connection --project <id> [--json]\n  zenifra valkey credentials rotate --project <id> [--idempotency-key <key>] [--wait] [--interval <seconds>] [--timeout <seconds>] [--json]\n  zenifra valkey credentials status --project <id> --operation <id> [--json]',
    description: 'Consulta projetos Valkey e gerencia suas conexoes e credenciais.',
    examples: ['zenifra valkey status --project proj_1', 'zenifra valkey connection --project proj_1', 'zenifra valkey credentials rotate --project proj_1 --wait'],
    output: 'Zenifra CLI - valkey',
    notes: ['A string de conexao completa aparece somente quando uma criacao ou rotacao a disponibiliza.'],
  },
  {
    command: 'valkey status',
    usage: 'zenifra valkey status --project <id> [--json]',
    description: 'Mostra estado, perfil, versao e persistencia de um projeto Valkey.',
    flags: ['--project <id>  ID do projeto.', '--json          Imprime a resposta em JSON.'],
    examples: ['zenifra valkey status --project proj_1'],
    output: 'Status     Perfil  Versao  Persistente  Instancias\nrunning    cache   9.1.1   nao           1',
  },
  {
    command: 'valkey connection',
    usage: 'zenifra valkey connection --project <id> [--json]',
    description: 'Mostra os dados de conexao de um projeto Valkey sem revelar a credencial.',
    flags: ['--project <id>  ID do projeto.', '--json          Imprime a resposta em JSON.'],
    examples: ['zenifra valkey connection --project proj_1'],
    output: 'Host                 Porta  TLS  Conexao\nvalkey.example.com   6380   sim  valkeys://default:********@valkey.example.com:6380/0',
    notes: ['Use a credencial recebida na criacao ou em uma rotacao concluida.'],
  },
  {
    command: 'valkey credentials',
    usage: 'zenifra valkey credentials\n  zenifra valkey credentials rotate --project <id> [--idempotency-key <key>] [--wait] [--interval <seconds>] [--timeout <seconds>] [--json]\n  zenifra valkey credentials status --project <id> --operation <id> [--json]',
    description: 'Agrupa comandos de renovacao e acompanhamento de credenciais Valkey.',
    examples: ['zenifra valkey credentials rotate --project proj_1', 'zenifra valkey credentials status --project proj_1 --operation operation_1'],
    output: 'Zenifra CLI - valkey credentials',
  },
  {
    command: 'valkey credentials rotate',
    usage: 'zenifra valkey credentials rotate --project <id> [--idempotency-key <key>] [--wait] [--interval <seconds>] [--timeout <seconds>] [--json]',
    description: 'Solicita a renovacao da credencial e retorna uma operacao acompanhavel.',
    flags: ['--project <id>          ID do projeto.', '--idempotency-key <key> Chave para repetir a mesma solicitacao.', '--wait                  Aguarda a conclusao.', '--interval <seconds>    Intervalo do polling. Padrao: 2.', '--timeout <seconds>     Timeout total. Padrao: 900.', '--json                  Imprime a resposta em JSON.'],
    examples: ['zenifra valkey credentials rotate --project proj_1', 'zenifra valkey credentials rotate --project proj_1 --wait --timeout 120'],
    output: 'Operacao aceita: rotation_123\nEstado: accepted',
    notes: ['Salve a nova string de conexao quando a operacao atingir completed.'],
  },
  {
    command: 'valkey credentials status',
    usage: 'zenifra valkey credentials status --project <id> --operation <id> [--json]',
    description: 'Consulta o estado de uma renovacao de credencial Valkey.',
    flags: ['--project <id>     ID do projeto.', '--operation <id>   ID da operacao.', '--json             Imprime a resposta em JSON.'],
    examples: ['zenifra valkey credentials status --project proj_1 --operation rotation_123'],
    output: 'Operacao: rotation_123\nEstado: completed',
  },
  {
    command: 'projects',
    usage: 'zenifra projects [--json] [--org <id>] [--type <http|postgresql|mariadb|valkey|job>] [--page <n>] [--limit <n>]',
    description: 'Lista projetos da organizacao ativa ou da API key.',
    flags: ['--json       Imprime a resposta em JSON.', '--org <id>   Usa uma organizacao especifica com sessao de usuario.', '--type <type> Filtra por tipo de projeto.', '--page <n>   Pagina. Padrao: 1.', '--limit <n>  Itens por pagina. Padrao: 15.'],
    examples: ['zenifra projects --type http --page 1 --limit 15', 'zenifra projects --json'],
    output: 'ID                        Nome     Status   Plano   Tipo\n507f1f77bcf86cd799439012  api-web  running  free    http',
    jsonOutput: '{"projects":[{"id":"507f1f77bcf86cd799439012","name":"api-web","status":"running","type_project":"http"}],"pagination":{"page":1,"limit":15,"total":1,"pages":1}}',
  },
  {
    command: 'create project',
    usage: 'zenifra create project\n  zenifra create project --name <name> --plan <plan> [--payment-mode <mode>] --config <json|@file> [--description <text>] [--idempotency-key <key>] [--org <id>] [--json]',
    description: 'Cria um projeto via wizard interativo ou via payload de configuracao JSON.',
    flags: ['--name <name>             Nome do projeto.', '--plan <plan>             Plano do projeto.', '--payment-mode <mode>     Opcional para Jobs; demais tipos seguem a validacao do catalogo.', '--config <json|@file>     JSON inline ou arquivo.', '--description <text>      Descricao opcional.', '--idempotency-key <key>   Chave para repetir a mesma criacao com seguranca.', '--json                    Imprime a resposta em JSON.'],
    examples: ['zenifra create project', 'zenifra create project --name api-web --plan free --payment-mode hourly --config @examples/http-project.json'],
    output: 'Campo    Valor\n-------  --------------------------------------\nProjeto  507f1f77bcf86cd799439012\nDominio  https://api-web.client.zenifra.com',
    jsonOutput: '{"status":"success","data":{"id":"507f1f77bcf86cd799439012","name":"api-web"}}',
    notes: ['Sem flags de criacao, a CLI abre um wizard guiado com docs, exemplos e indicacao de campos obrigatorios.'],
  },
  {
    command: 'project',
    usage: 'zenifra project\n  zenifra project info --project <id> [--json]\n  zenifra project url --project <id> [--json]\n  zenifra project logs --project <id> [--instance <id>] [--json]\n  zenifra project runs --project <id> [--page <n>] [--limit <n>] [--json]\n  zenifra project runs logs --project <id> --run <id> [--json]\n  zenifra project metrics --project <id> [--instance <id>] [--json]\n  zenifra project metrics capabilities --project <id> [--json]\n  zenifra project healthcheck get --project <id> [--json]\n  zenifra project healthcheck set --project <id> --path /health [--json]\n  zenifra project healthcheck disable --project <id> [--json]\n  zenifra project healthcheck failures --project <id> [--page <n>] [--limit <n>] [--json]\n  zenifra project network --project <id> [--view <summary|status-codes|routes|user-agents|request-events|source-ips>] [--json]\n  zenifra project image set --project <id> --image <image> [--json]\n  zenifra project exposure set --project <id> --exposure <public|private> [--json]\n  zenifra project envs --project <id> [--json] [--show-values]\n  zenifra project env add --project <id> --name <name> --value <value> [--json]\n  zenifra project env update --project <id> --name <name> --value <value> [--json]\n  zenifra project env remove --project <id> --name <name> [--json]\n  zenifra project autoscaling --project <id> [--json]\n  zenifra project autoscaling set --project <id> --min <n> --max <n> [--cpu <percent>] [--memory <percent>] [--json]\n  zenifra project autoscaling disable --project <id> [--json]\n  zenifra project autoscaling events --project <id> [--direction <scale_up|scale_down>] [--from <iso>] [--to <iso>] [--page <n>] [--limit <n>] [--json]\n  zenifra project billing usage --project <id> [--from <iso>] [--to <iso>] [--page <n>] [--limit <n>] [--json]\n  zenifra project instances --project <id> [--json]\n  zenifra project instances set --project <id> --count <n> [--json]',
    description: 'Agrupa comandos operacionais e de introspecao sobre um projeto especifico.',
    examples: ['zenifra project', 'zenifra project info --project proj_1', 'zenifra project env add --project proj_1 --name NODE_ENV --value production'],
    output: 'Zenifra CLI - project',
    notes: ['Use "zenifra help project <subcomando>" para detalhes de info, url, logs, metrics, capabilities, network, image, exposure, autoscaling, billing, envs e instances.'],
  },
  {
    command: 'project info',
    usage: 'zenifra project info --project <id> [--json]',
    description: 'Mostra dados principais de um projeto.',
    flags: ['--project <id>  ID do projeto.', '--json          Imprime a resposta em JSON.'],
    examples: ['zenifra project info --project 507f1f77bcf86cd799439012'],
    output: 'Nome: api-web\nStatus: running\nURL: https://api-web.client.zenifra.com\nInstancias: 2',
    jsonOutput: '{"name":"api-web","status":"running","domain":"api-web.client.zenifra.com","instances":2}',
  },
  {
    command: 'project url',
    usage: 'zenifra project url --project <id> [--json]',
    description: 'Imprime a URL publica principal do projeto.',
    flags: ['--project <id>  ID do projeto.', '--json          Inclui dominio e custom domains em JSON.'],
    examples: ['zenifra project url --project 507f1f77bcf86cd799439012'],
    output: 'https://api-web.client.zenifra.com',
    jsonOutput: '{"project_id":"507f1f77bcf86cd799439012","url":"https://api-web.client.zenifra.com","domain":"api-web.client.zenifra.com","custom_domains":[]}',
  },
  {
    command: 'project logs',
    usage: 'zenifra project logs --project <id> [--instance <id>] [--json]',
    description: 'Mostra snapshot dos logs de runtime do projeto.',
    flags: ['--project <id>   ID do projeto.', '--instance <id>  Filtra uma instancia.', '--json           Imprime a resposta em JSON.'],
    examples: ['zenifra project logs --project 507f1f77bcf86cd799439012', 'zenifra project logs --project 507f1f77bcf86cd799439012 --instance web-1'],
    output: 'server started\nGET /health 200',
    jsonOutput: '"server started\\nGET /health 200"',
    notes: ['Nao faz streaming continuo; retorna o snapshot disponibilizado pela API.'],
  },
  {
    command: 'project runs',
    usage: 'zenifra project runs --project <id> [--page <n>] [--limit <n>] [--json]',
    description: 'Lista as execucoes de um Job agendado com o historico de cobranca.',
    flags: ['--project <id>  ID do projeto.', '--page <n>      Pagina. Padrao: 1.', '--limit <n>     Itens por pagina. Maximo: 50.', '--json          Imprime a resposta em JSON.'],
    examples: ['zenifra project runs --project 507f1f77bcf86cd799439012', 'zenifra project runs --project 507f1f77bcf86cd799439012 --page 2 --limit 20 --json'],
    output: 'ID      Status     Agendada                  Minutos cobrados  Valor\nrun_1   succeeded  2026-09-01T12:00:00.000Z  2                 R$ 0,04',
    jsonOutput: '{"runs":[{"id":"run_1","status":"succeeded","billed_minutes":2,"currency":"brl","amount":0.04}],"pagination":{"page":1,"limit":20,"total":1,"total_pages":1}}',
  },
  {
    command: 'project runs cancel',
    usage: 'zenifra project runs cancel --project <id> --run <id> [--json]',
    description: 'Cancela uma execucao ativa de um Job e cobra somente o tempo consumido.',
    flags: ['--project <id>  ID do projeto.', '--run <id>      ID publico da execucao.', '--json          Imprime a resposta em JSON.'],
    examples: ['zenifra project runs cancel --project 507f1f77bcf86cd799439012 --run run_1'],
    output: 'Execucao: cancelled',
    jsonOutput: '{"run":{"id":"run_1","status":"cancelled","billed_minutes":2}}',
  },
  {
    command: 'project runs logs',
    usage: 'zenifra project runs logs --project <id> --run <id> [--json]',
    description: 'Mostra os logs de uma execucao especifica de um Job agendado.',
    flags: ['--project <id>  ID do projeto.', '--run <id>      ID publico da execucao.', '--json          Imprime a resposta em JSON.'],
    examples: ['zenifra project runs logs --project 507f1f77bcf86cd799439012 --run run_1', 'zenifra project runs logs --project 507f1f77bcf86cd799439012 --run run_1 --json'],
    output: 'started\ncompleted',
    jsonOutput: '{"logs":"started\\ncompleted","truncated":false}',
    notes: ['Os logs pertencem a uma execucao identificada pelo ID publico retornado em project runs.'],
  },
  {
    command: 'project metrics',
    usage: 'zenifra project metrics --project <id> [--instance <id>] [--json]',
    description: 'Mostra metricas de recursos do projeto e, para Valkey, o snapshot nativo da instancia.',
    flags: ['--project <id>   ID do projeto.', '--instance <id>  Filtra uma instancia.', '--json           Imprime a resposta em JSON sem formatacao adicional.'],
    examples: ['zenifra project metrics --project 507f1f77bcf86cd799439012 --instance web-1', 'zenifra project metrics --project 507f1f77bcf86cd799439012 --instance instance-1'],
    output: 'Campo       Valor\n----------  ----------------\nPerfil      cache\nDisponibilidade  available\nMemoria usada    100 MB',
    jsonOutput: '{"instance":"instance-1","type":"valkey","availability":"available","valkey":{"schema_version":1,"profile":"cache","memory":{"used_bytes":104857600}}}',
    notes: [
      'Para projetos Valkey, a saida legivel inclui recursos, capacidade, clientes, atividade, ciclo de vida de chaves, perfil e confiabilidade.',
      'Valores ausentes sao exibidos como indisponivel; zero continua sendo um valor valido.',
      'Use "zenifra project metrics capabilities --project <id>" para consultar o acesso e os grupos de metricas disponiveis.',
    ],
  },
  {
    command: 'project metrics capabilities',
    usage: 'zenifra project metrics capabilities --project <id> [--json]',
    description: 'Mostra os grupos de metricas e o nivel de acesso disponivel para o projeto.',
    flags: ['--project <id>  ID do projeto.', '--json          Imprime a resposta em JSON.'],
    examples: ['zenifra project metrics capabilities --project 507f1f77bcf86cd799439012'],
    output: 'Campo       Valor\n----------  ------------------------------------------------------------\nAcesso      snapshot\nAtualizacao 60 s\nHistorico   indisponivel',
    jsonOutput: '{"access":"snapshot","groups":["resources","capacity","clients","activity","key_lifecycle","profile","reliability"],"refresh_seconds":60,"history":null}',
    notes: ['A API permanece como fonte de autorizacao. A CLI nao mantem uma lista local de planos.'],
  },
  {
    command: 'project healthcheck',
    usage: 'zenifra project healthcheck\n  zenifra project healthcheck get --project <id> [--json]\n  zenifra project healthcheck set --project <id> --path /health [--json]\n  zenifra project healthcheck disable --project <id> [--json]\n  zenifra project healthcheck failures --project <id> [--page <n>] [--limit <n>] [--json]',
    description: 'Consulta e gerencia a verificacao de saude de um projeto HTTP.',
    examples: ['zenifra project healthcheck get --project 507f1f77bcf86cd799439012', 'zenifra project healthcheck failures --project 507f1f77bcf86cd799439012'],
    output: 'Zenifra CLI - project healthcheck',
    notes: ['Use "zenifra help project healthcheck <subcomando>" para detalhes de get, set, disable e failures.'],
  },
  {
    command: 'project healthcheck get',
    usage: 'zenifra project healthcheck get --project <id> [--json]',
    description: 'Mostra a configuracao e o estado atual da verificacao de saude do projeto.',
    flags: ['--project <id>  ID do projeto.', '--json          Imprime a resposta publica em JSON.'],
    examples: ['zenifra project healthcheck get --project 507f1f77bcf86cd799439012'],
    output: 'Campo       Valor\n----------  ----------\nStatus      ativo\nRota        /health\nVerificacao configurada',
    jsonOutput: '{"available":true,"healthcheck":{"enabled":true,"path":"/health"},"interval_seconds":60,"retention_days":30}',
  },
  {
    command: 'project healthcheck set',
    usage: 'zenifra project healthcheck set --project <id> --path /health [--json]',
    description: 'Ativa a verificacao de saude do projeto usando a rota informada.',
    flags: ['--project <id>  ID do projeto.', '--path <path>   Rota HTTP absoluta da aplicacao.', '--json          Imprime a resposta publica em JSON.'],
    examples: ['zenifra project healthcheck set --project 507f1f77bcf86cd799439012 --path /health'],
    output: 'Verificacao de saude ativada.\nRota: /health',
    jsonOutput: '{"healthcheck":{"enabled":true,"path":"/health"},"interval_seconds":60,"retention_days":30}',
    notes: ['A rota deve comecar com / e nao pode conter host, query string ou fragmento.'],
  },
  {
    command: 'project healthcheck disable',
    usage: 'zenifra project healthcheck disable --project <id> [--json]',
    description: 'Desativa a verificacao de saude do projeto sem apagar a rota configurada.',
    flags: ['--project <id>  ID do projeto.', '--json          Imprime a resposta publica em JSON.'],
    examples: ['zenifra project healthcheck disable --project 507f1f77bcf86cd799439012'],
    output: 'Verificacao de saude desativada.',
    jsonOutput: '{"healthcheck":{"enabled":false,"path":"/health"},"interval_seconds":60,"retention_days":30}',
  },
  {
    command: 'project healthcheck failures',
    usage: 'zenifra project healthcheck failures --project <id> [--page <n>] [--limit <n>] [--json]',
    description: 'Lista as falhas publicas de verificacao de saude dos ultimos 30 dias.',
    flags: ['--project <id>  ID do projeto.', '--page <n>      Pagina. Padrao da API: 1.', '--limit <n>     Itens por pagina. Maximo: 100.', '--json          Imprime a resposta publica em JSON.'],
    examples: ['zenifra project healthcheck failures --project 507f1f77bcf86cd799439012', 'zenifra project healthcheck failures --project 507f1f77bcf86cd799439012 --page 2 --limit 10'],
    output: 'Quando                    Status\n2026-08-31T12:00:00.000Z  503',
    jsonOutput: '{"failures":[{"occurred_at":"2026-08-31T12:00:00.000Z","status_code":503}],"pagination":{"page":1,"limit":10,"total":1,"total_pages":1}}',
    notes: ['O historico e limitado aos 30 dias anteriores.'],
  },
  {
    command: 'project network',
    usage: 'zenifra project network --project <id> [--view <summary|status-codes|routes|user-agents|request-events|source-ips>] [--json]',
    description: 'Mostra analytics de rede para projetos HTTP.',
    flags: ['--project <id>  ID do projeto.', '--view <view>   Visao de rede. Padrao: summary.', '--json          Imprime a resposta em JSON.'],
    examples: ['zenifra project network --project 507f1f77bcf86cd799439012 --view summary'],
    output: '{"requests":120,"bytes_received":4096,"bytes_sent":8192}',
    jsonOutput: '{"requests":120,"bytes_received":4096,"bytes_sent":8192}',
  },
  {
    command: 'project image set',
    usage: 'zenifra project image set --project <id> --image <image> [--json]',
    description: 'Atualiza a imagem de deploy do projeto.',
    flags: ['--project <id>  ID do projeto.', '--image <image> Imagem completa.', '--json          Imprime a resposta em JSON.'],
    examples: ['zenifra project image set --project 507f1f77bcf86cd799439012 --image ghcr.io/zenifra/app:1.2.3'],
    output: 'Imagem atualizada com sucesso.',
    jsonOutput: '{"status":"success","message":"updated with success"}',
  },
  {
    command: 'project exposure set',
    usage: 'zenifra project exposure set --project <id> --exposure <public|private> [--json]',
    description: 'Altera se um projeto HTTP expoe rota publica e dominio.',
    flags: ['--project <id>    ID do projeto.', '--exposure <mode> Use public para criar rota publica ou private para remover exposicao.', '--json            Imprime a resposta em JSON.'],
    examples: ['zenifra project exposure set --project 507f1f77bcf86cd799439012 --exposure private', 'zenifra project exposure set --project 507f1f77bcf86cd799439012 --exposure public --json'],
    output: 'Campo      Valor\n---------  ----------------------------------\nExposicao  private\nDominio    -',
    jsonOutput: '{"status":"success","message":"project exposure updated with success","exposure":"private","custom_domains":[]}',
    notes: ['Ao mudar para private, a API remove a rota publica e dominios personalizados do projeto.'],
  },
  {
    command: 'project envs',
    usage: 'zenifra project envs --project <id> [--json] [--show-values]',
    description: 'Lista variaveis de ambiente do projeto.',
    flags: ['--project <id>  ID do projeto.', '--json          Imprime a resposta em JSON.', '--show-values   Mostra valores completos. Use com cuidado.'],
    examples: ['zenifra project envs --project 507f1f77bcf86cd799439012'],
    output: 'Nome      Valor\nNODE_ENV  ********',
    jsonOutput: '[{"name":"NODE_ENV","value":"********"}]',
    notes: ['Valores sao mascarados por padrao, inclusive em JSON.'],
  },
  {
    command: 'project env add',
    usage: 'zenifra project env add --project <id> --name <name> --value <value> [--json]',
    description: 'Adiciona uma variavel de ambiente ao projeto.',
    flags: ['--project <id>  ID do projeto.', '--name <name>   Nome da variavel.', '--value <value> Valor da variavel.', '--json          Imprime a resposta em JSON.'],
    examples: ['zenifra project env add --project 507f1f77bcf86cd799439012 --name NODE_ENV --value production'],
    output: 'Env NODE_ENV atualizada com sucesso.',
    jsonOutput: '{"status":"success","message":"updated with success","envs":[{"name":"NODE_ENV","value":"********"}]}',
    notes: ['Falha se a variavel ja existir. Use update para alterar.'],
  },
  {
    command: 'project env update',
    usage: 'zenifra project env update --project <id> --name <name> --value <value> [--json]',
    description: 'Atualiza uma variavel de ambiente existente.',
    flags: ['--project <id>  ID do projeto.', '--name <name>   Nome da variavel.', '--value <value> Novo valor.', '--json          Imprime a resposta em JSON.'],
    examples: ['zenifra project env update --project 507f1f77bcf86cd799439012 --name NODE_ENV --value staging'],
    output: 'Env NODE_ENV atualizada com sucesso.',
    jsonOutput: '{"status":"success","message":"updated with success","envs":[{"name":"NODE_ENV","value":"********"}]}',
    notes: ['Falha se a variavel nao existir.'],
  },
  {
    command: 'project env remove',
    usage: 'zenifra project env remove --project <id> --name <name> [--json]',
    description: 'Remove uma variavel de ambiente existente.',
    flags: ['--project <id>  ID do projeto.', '--name <name>   Nome da variavel.', '--json          Imprime a resposta em JSON.'],
    examples: ['zenifra project env remove --project 507f1f77bcf86cd799439012 --name NODE_ENV'],
    output: 'Env NODE_ENV removida com sucesso.',
    jsonOutput: '{"status":"success","message":"updated with success","envs":[]}',
    notes: ['Falha se a variavel nao existir.'],
  },
  {
    command: 'project autoscaling',
    usage: 'zenifra project autoscaling --project <id> [--json]',
    description: 'Mostra a configuracao de auto-scaling HTTP do projeto.',
    flags: ['--project <id>  ID do projeto.', '--json          Imprime a resposta em JSON.'],
    examples: ['zenifra project autoscaling --project 507f1f77bcf86cd799439012'],
    output: 'Campo       Valor\n----------  -----\nStatus      ativo\nMinimo      2\nMaximo      8\nCPU alvo    70%\nMemoria     80%',
    jsonOutput: '{"enabled":true,"min_instances":2,"max_instances":8,"target_cpu_utilization_percent":70,"target_memory_utilization_percent":80}',
  },
  {
    command: 'project autoscaling set',
    usage: 'zenifra project autoscaling set --project <id> --min <n> --max <n> [--cpu <percent>] [--memory <percent>] [--json]',
    description: 'Ativa ou atualiza o auto-scaling HTTP do projeto.',
    flags: ['--project <id>    ID do projeto.', '--min <n>        Minimo de instancias reservadas.', '--max <n>        Maximo de instancias permitidas.', '--cpu <percent>  CPU alvo. Padrao da API: 70.', '--memory <percent> Memoria alvo. Padrao da API: 80.', '--json           Imprime a resposta em JSON.'],
    examples: ['zenifra project autoscaling set --project 507f1f77bcf86cd799439012 --min 2 --max 8 --cpu 70 --memory 80'],
    output: 'Auto-scaling atualizado: 2-8 instancias.',
    jsonOutput: '{"status":"success","message":"project autoscaling updated with success","data":{"autoscaling":{"enabled":true,"min_instances":2,"max_instances":8}}}',
  },
  {
    command: 'project autoscaling disable',
    usage: 'zenifra project autoscaling disable --project <id> [--json]',
    description: 'Desativa o auto-scaling HTTP e volta para instancias fixas no minimo configurado.',
    flags: ['--project <id>  ID do projeto.', '--json          Imprime a resposta em JSON.'],
    examples: ['zenifra project autoscaling disable --project 507f1f77bcf86cd799439012'],
    output: 'Auto-scaling desativado.',
    jsonOutput: '{"status":"success","message":"project autoscaling updated with success","data":{"autoscaling":{"enabled":false}}}',
  },
  {
    command: 'project autoscaling events',
    usage: 'zenifra project autoscaling events --project <id> [--direction <scale_up|scale_down>] [--from <iso>] [--to <iso>] [--page <n>] [--limit <n>] [--json]',
    description: 'Lista o historico de scale up e scale down do auto-scaling HTTP.',
    flags: ['--project <id>       ID do projeto.', '--direction <valor> Filtra por scale_up ou scale_down.', '--from <iso>         Inicio do periodo.', '--to <iso>           Fim do periodo.', '--page <n>           Pagina. Padrao da API: 1.', '--limit <n>          Itens por pagina. Maximo da API: 100.', '--json               Imprime a resposta em JSON.'],
    examples: ['zenifra project autoscaling events --project 507f1f77bcf86cd799439012 --direction scale_up'],
    output: 'Quando                    Direcao   Instancias  Limites          Motivo\n05/06/2026, 18:40        aumento   2 -> 5     CPU 91%/70%    capacidade aumentada',
    jsonOutput: '{"events":[{"direction":"scale_up","previous_instances":2,"new_instances":5,"occurred_at":"2026-06-05T21:40:00.000Z"}],"pagination":{"page":1,"limit":10,"total":1,"total_pages":1}}',
  },
  {
    command: 'project billing usage',
    usage: 'zenifra project billing usage --project <id> [--from <iso>] [--to <iso>] [--page <n>] [--limit <n>] [--json]',
    description: 'Lista o consumo horario consolidado de um projeto.',
    flags: ['--project <id>  ID do projeto.', '--from <iso>    Inicio do periodo.', '--to <iso>      Fim do periodo.', '--page <n>      Pagina. Padrao da API: 1.', '--limit <n>     Itens por pagina. Maximo: 50.', '--json          Imprime a resposta em JSON.'],
    examples: ['zenifra project billing usage --project 507f1f77bcf86cd799439012 --from 2026-06-01T00:00:00Z --limit 20'],
    output: 'Inicio                    Fim                       Instancia-horas  Armazenamento  Total\n2026-06-01T10:00:00.000Z  2026-06-01T11:00:00.000Z  2                1.5 GB-h         R$ 0,30',
    jsonOutput: '{"hours":[],"summary":{"currency":"brl","compute_amount":0,"storage_amount":0,"total_amount":0},"pagination":{"page":1,"limit":10,"total":0,"total_pages":0}}',
  },
  {
    command: 'project instances',
    usage: 'zenifra project instances --project <id> [--json]',
    description: 'Lista instancias do projeto.',
    flags: ['--project <id>  ID do projeto.', '--json          Imprime a resposta em JSON.'],
    examples: ['zenifra project instances --project 507f1f77bcf86cd799439012'],
    output: 'Instancia\nweb-1',
    jsonOutput: '[{"instance":"web-1"}]',
  },
  {
    command: 'project instances set',
    usage: 'zenifra project instances set --project <id> --count <n> [--json]',
    description: 'Atualiza a quantidade de instancias do projeto.',
    flags: ['--project <id>  ID do projeto.', '--count <n>     Quantidade desejada.', '--json          Imprime a resposta em JSON.'],
    examples: ['zenifra project instances set --project 507f1f77bcf86cd799439012 --count 3'],
    output: 'Quantidade de instancias atualizada para 3.',
    jsonOutput: '{"status":"success","message":"project instances changed with success"}',
  },
  {
    command: 'builds',
    usage: 'zenifra builds --project <id> [--page <n>] [--limit <n>] [--branch <name>] [--status <status>] [--json]',
    description: 'Lista builds GitHub de um projeto.',
    flags: ['--project <id>   ID do projeto.', '--page <n>      Pagina.', '--limit <n>     Itens por pagina.', '--branch <name> Filtra branch.', '--status <status> Filtra status.', '--json          Imprime a resposta em JSON.'],
    examples: ['zenifra builds --project 507f1f77bcf86cd799439012 --status success'],
    output: 'Build                     Status   Branch  Commit\nbuild_123                 success  main    abc123',
    jsonOutput: '[{"id":"build_123","status":"success","branch":"main","commit_sha":"abc123"}]',
  },
  {
    command: 'builds logs',
    usage: 'zenifra builds logs --project <id> --build <id> [--cursor <n>] [--limit <n>] [--follow] [--interval <seconds>] [--timeout <seconds>] [--json]',
    description: 'Lê os logs de um build GitHub existente e opcionalmente acompanha novos chunks em tempo real.',
    flags: [
      '--project <id>        ID do projeto.',
      '--build <id>          ID do build.',
      '--cursor <n>          Cursor inicial inteiro, maior ou igual a 0. Padrao: 0.',
      '--limit <n>           Quantidade de logs por request, entre 1 e 500. Padrao: 200.',
      '--follow              Continua em polling ate o build finalizar.',
      '--interval <seconds>  Intervalo de polling com --follow, minimo 0.1. Padrao: 5.',
      '--timeout <seconds>   Timeout total com --follow, minimo 1. Padrao: 900.',
      '--json                Imprime a resposta em JSON.',
    ],
    examples: ['zenifra builds logs --project 507f1f77bcf86cd799439012 --build build_123', 'zenifra builds logs --project 507f1f77bcf86cd799439012 --build build_123 --follow'],
    output: '[2026-05-27T12:00:00.000Z] install: npm ci\n[2026-05-27T12:00:05.000Z] build: npm run build',
    jsonOutput: '{"logs":[{"sequence":1,"timestamp":"2026-05-27T12:00:00.000Z","level":"info","step":"install","message":"npm ci","final":false}],"next_cursor":1,"status":"running","finished":false,"truncated":false}',
  },
  {
    command: 'deployments',
    usage: 'zenifra deployments --project <id> [--page <n>] [--limit <n>] [--branch <name>] [--status <status>] [--json]',
    description: 'Alias para listar builds/deployments GitHub de um projeto.',
    flags: ['--project <id>   ID do projeto.', '--page <n>      Pagina.', '--limit <n>     Itens por pagina.', '--branch <name> Filtra branch.', '--status <status> Filtra status.', '--json          Imprime a resposta em JSON.'],
    examples: ['zenifra deployments --project 507f1f77bcf86cd799439012'],
    output: 'Build                     Status   Branch  Commit\nbuild_123                 success  main    abc123',
    jsonOutput: '[{"id":"build_123","status":"success","branch":"main","commit_sha":"abc123"}]',
  },
  {
    command: 'deploy',
    usage: 'zenifra deploy --project <id> [--branch <name>] [--commit-sha <sha>] [--json]',
    description: 'Dispara um build/deploy GitHub para o projeto e retorna o build_id para acompanhamento posterior.',
    flags: ['--project <id>    ID do projeto.', '--branch <name>  Branch a publicar.', '--commit-sha <sha> Commit especifico.', '--json           Imprime a resposta em JSON.'],
    examples: [
      'zenifra deploy --project 507f1f77bcf86cd799439012 --branch main',
      'zenifra deploy watch --project 507f1f77bcf86cd799439012 --build build_123',
    ],
    output: 'Deploy iniciado: build_123',
    jsonOutput: '{"status":"success","data":{"build_id":"build_123"}}',
    notes: [
      'Use o build_id retornado para acompanhar a execucao com "zenifra deploy watch --project <id> --build <build_id>".',
      'O subcomando "deploy watch" acompanha status e logs incrementais do build ate o estado terminal.',
    ],
  },
  {
    command: 'deploy watch',
    usage: 'zenifra deploy watch --project <id> --build <id> [--interval <seconds>] [--timeout <seconds>] [--json]',
    description: 'Acompanha um build em tempo real, fazendo polling do status e imprimindo os logs incrementais do build ate o estado terminal.',
    flags: ['--project <id>        ID do projeto.', '--build <id>          ID do build.', '--interval <seconds>  Intervalo de polling, minimo 0.1. Padrao: 5.', '--timeout <seconds>   Timeout total, minimo 1. Padrao: 900.', '--json                Imprime cada resposta em JSON.'],
    examples: [
      'zenifra deploy watch --project 507f1f77bcf86cd799439012 --build build_123',
      'zenifra deploy watch --project 507f1f77bcf86cd799439012 --build build_123 --interval 2',
      'zenifra deploy watch --project 507f1f77bcf86cd799439012 --build build_123 --json',
    ],
    output: '[2026-05-27T12:00:00.000Z] install: npm ci\n[2026-05-27T12:00:05.000Z] build: npm run build\n[2026-05-27T12:00:09.000Z] publish: Build concluida e publicada',
    jsonOutput: '{"sequence":1,"timestamp":"2026-05-27T12:00:00.000Z","level":"info","step":"install","message":"npm ci","final":false}',
    notes: [
      'Use este subcomando logo apos "zenifra deploy" para acompanhar o build pelo build_id retornado.',
      'No modo --json, o comando imprime eventos de log em streaming, um JSON por linha.',
    ],
  },
];

const HELP_BY_COMMAND = new Map(HELP_SPECS.map((spec) => [spec.command, spec]));

function formatHelp(spec) {
  const sections = [
    `Zenifra CLI - ${spec.command}`,
    '',
    'Usage:',
    `  ${spec.usage}`,
    '',
    'Description:',
    `  ${spec.description}`,
  ];

  if (spec.flags?.length) {
    sections.push('', 'Flags:', ...spec.flags.map((flag) => `  ${flag}`));
  }

  sections.push('', 'Examples:', ...spec.examples.map((example) => `  ${example}`));
  sections.push('', 'Example output:', spec.output.split('\n').map((line) => `  ${line}`).join('\n'));

  if (spec.jsonOutput) {
    sections.push('', 'Example JSON output:', `  ${spec.jsonOutput}`);
  }

  if (spec.notes?.length) {
    sections.push('', 'Notes:', ...spec.notes.map((note) => `  ${note}`));
  }

  return `${sections.join('\n')}\n`;
}

function helpKeyFromPositionals(positionals) {
  return positionals.filter((value) => value !== 'help').join(' ').trim();
}

function commandHelp(positionals) {
  const key = helpKeyFromPositionals(positionals);
  if (!key) return usage();

  const spec = HELP_BY_COMMAND.get(key)
    || (key === 'project run logs' ? HELP_BY_COMMAND.get('project runs logs') : undefined);
  if (!spec) {
    throw new CliError(`Ajuda nao encontrada para: ${key}. Use "zenifra help <command>".`);
  }

  return formatHelp(spec);
}

function printCommandHelpAndFail(commandKey) {
  const positionals = Array.isArray(commandKey) ? commandKey : String(commandKey).split(' ')
  process.stdout.write(commandHelp(positionals))
  process.exitCode = 1
}

function isRemovedProjectsCreate(positionals) {
  return positionals[0] === 'projects' && positionals[1] === 'create';
}

function removedProjectsCreateMessage() {
  return 'Comando removido. Use "zenifra create project". Veja "zenifra help create project" ou "zenifra create project --help".';
}

function isNamespaceCommand(command) {
  return ['auth', 'profile', 'project', 'org', 'valkey'].includes(command);
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

function flagNameForDisplay(value) {
  return `--${String(value).replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)}`;
}

function validateKnownFlags(flags) {
  const unknown = Object.keys(flags).filter((name) => !KNOWN_FLAG_NAMES.has(name));
  if (unknown.length > 0) {
    throw new CliError(`Flag desconhecida: ${unknown.map(flagNameForDisplay).join(', ')}.`);
  }
}

function emptyProfileStore() {
  return {
    version: PROFILE_STORE_VERSION,
    activeProfile: null,
    profiles: {},
  };
}

function normalizeApiBaseUrl(value) {
  return String(value || DEFAULT_API_BASE_URL).replace(/\/$/, '');
}

function normalizeProfileName(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    throw new CliError('Nome de perfil obrigatorio.');
  }
  if (!/^[a-z0-9._-]+$/.test(normalized)) {
    throw new CliError('Nome de perfil invalido. Use apenas letras, numeros, ponto, underscore e hifen.');
  }
  return normalized;
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeProfileRecord(name, profile = {}) {
  return {
    name,
    description: profile.description ? String(profile.description) : '',
    authMode: profile.authMode === 'access_token' ? 'access_token' : 'api_key',
    apiBaseUrl: normalizeApiBaseUrl(profile.apiBaseUrl),
    apiKey: profile.apiKey ? String(profile.apiKey) : undefined,
    accessToken: profile.accessToken ? String(profile.accessToken) : undefined,
    selectedOrganizationId: profile.selectedOrganizationId ? String(profile.selectedOrganizationId) : undefined,
    updatedAt: profile.updatedAt ? String(profile.updatedAt) : undefined,
  };
}

function sanitizeProfileStore(store) {
  const next = emptyProfileStore();
  if (!isRecord(store)) return next;
  next.version = PROFILE_STORE_VERSION;
  const rawProfiles = isRecord(store.profiles) ? store.profiles : {};
  for (const [rawName, rawProfile] of Object.entries(rawProfiles)) {
    const name = normalizeProfileName(rawName);
    next.profiles[name] = normalizeProfileRecord(name, rawProfile);
  }
  if (store.activeProfile && next.profiles[normalizeProfileName(store.activeProfile)]) {
    next.activeProfile = normalizeProfileName(store.activeProfile);
  }
  return next;
}

async function writeProfileStore(store) {
  const normalized = sanitizeProfileStore(store);
  await mkdir(dirname(PROFILES_FILE), { recursive: true });
  await writeFile(PROFILES_FILE, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(PROFILES_FILE, 0o600).catch(() => undefined);
  return normalized;
}

async function readLegacySession() {
  if (!existsSync(SESSION_FILE)) return null;
  try {
    return JSON.parse(await readFile(SESSION_FILE, 'utf8'));
  } catch {
    throw new CliError(`Sessao local invalida em ${SESSION_FILE}. Rode "zenifra auth logout" e faca login novamente.`);
  }
}

async function migrateLegacySession() {
  const legacy = await readLegacySession();
  if (!legacy) {
    return emptyProfileStore();
  }
  const store = emptyProfileStore();
  const migratedProfile = normalizeProfileRecord(DEFAULT_PROFILE_NAME, {
    description: 'Perfil migrado automaticamente do session.json legado.',
    authMode: legacy.accessToken ? 'access_token' : 'api_key',
    apiBaseUrl: legacy.apiBaseUrl || DEFAULT_API_BASE_URL,
    apiKey: legacy.apiKey,
    accessToken: legacy.accessToken,
    selectedOrganizationId: legacy.selectedOrganizationId,
    updatedAt: legacy.updatedAt || new Date().toISOString(),
  });
  store.profiles[DEFAULT_PROFILE_NAME] = migratedProfile;
  store.activeProfile = DEFAULT_PROFILE_NAME;
  const normalized = await writeProfileStore(store);
  await rm(SESSION_FILE, { force: true });
  return normalized;
}

async function readProfileStore() {
  if (existsSync(PROFILES_FILE)) {
    try {
      return sanitizeProfileStore(JSON.parse(await readFile(PROFILES_FILE, 'utf8')));
    } catch {
      throw new CliError(`Store de perfis invalido em ${PROFILES_FILE}. Corrija o arquivo ou remova-o para recriar.`);
    }
  }
  return migrateLegacySession();
}

function buildSession(store) {
  const activeName = store.activeProfile && store.profiles[store.activeProfile] ? store.activeProfile : null;
  const activeProfile = activeName ? store.profiles[activeName] : {};
  return {
    ...activeProfile,
    __store: store,
    __profileName: activeName,
  };
}

async function readSession() {
  return buildSession(await readProfileStore());
}

function getStore(session) {
  return session.__store || emptyProfileStore();
}

function getProfileName(session) {
  return session.__profileName || null;
}

function getProfileRecord(session, explicitName) {
  const store = getStore(session);
  const name = explicitName ? normalizeProfileName(explicitName) : getProfileName(session);
  if (!name) return null;
  return store.profiles[name] ? { name, profile: store.profiles[name], store } : null;
}

async function persistSession(session) {
  const store = getStore(session);
  const profileName = getProfileName(session);
  if (!profileName) {
    return writeProfileStore(store);
  }
  store.profiles[profileName] = normalizeProfileRecord(profileName, session);
  if (!store.activeProfile || store.activeProfile === profileName) {
    store.activeProfile = profileName;
  }
  const normalized = await writeProfileStore(store);
  session.__store = normalized;
  session.__profileName = profileName;
  return normalized;
}

function buildProfileSession(store, profileName) {
  const name = normalizeProfileName(profileName);
  const profile = store.profiles[name] || normalizeProfileRecord(name, { apiBaseUrl: DEFAULT_API_BASE_URL });
  return {
    ...profile,
    __store: store,
    __profileName: name,
  };
}

function ensureProfile(session, requestedName, { activate = false } = {}) {
  const store = getStore(session);
  const profileName = requestedName ? normalizeProfileName(requestedName) : getProfileName(session) || DEFAULT_PROFILE_NAME;
  if (!store.profiles[profileName]) {
    store.profiles[profileName] = normalizeProfileRecord(profileName, { apiBaseUrl: DEFAULT_API_BASE_URL });
  }
  if (activate || !store.activeProfile) {
    store.activeProfile = profileName;
  }
  session.__store = store;
  if (activate) {
    session.__profileName = profileName;
  }
  return buildProfileSession(store, profileName);
}

function requireExistingProfile(session, requestedName) {
  const profileName = normalizeProfileName(requestedName || getProfileName(session));
  const store = getStore(session);
  if (!store.profiles[profileName]) {
    throw new CliError(`Perfil nao encontrado: ${profileName}`);
  }
  return buildProfileSession(store, profileName);
}

function activateProfileSession(session, profileName) {
  const store = getStore(session);
  const name = normalizeProfileName(profileName);
  if (!store.profiles[name]) {
    throw new CliError(`Perfil nao encontrado: ${name}`);
  }
  const next = buildProfileSession({ ...store, activeProfile: name }, name);
  Object.assign(session, next);
  session.__store.activeProfile = name;
  return session;
}

function profileApiBaseUrl(profile, flags) {
  return normalizeApiBaseUrl(flags.apiBase || process.env.ZENIFRA_API_URL || profile?.apiBaseUrl || DEFAULT_API_BASE_URL);
}

function apiBaseUrl(session, flags) {
  return profileApiBaseUrl(session, flags);
}

function resolveCredential(session) {
  if (process.env.ZENIFRA_API_KEY) {
    return { token: process.env.ZENIFRA_API_KEY, type: 'api_key', source: 'env' };
  }
  if (session.apiKey) {
    return { token: session.apiKey, type: 'api_key', source: 'profile' };
  }
  if (session.accessToken) {
    return { token: session.accessToken, type: 'user', source: 'profile' };
  }
  return null;
}

function hasApiKeyCredential(session) {
  return Boolean(process.env.ZENIFRA_API_KEY || session.apiKey);
}

function requireUserSession(session, action) {
  if (session.accessToken) return;
  if (hasApiKeyCredential(session)) {
    throw new CliError(`${action} exige login de usuario. A API key global ja define a organizacao para comandos de automacao.`);
  }
  throw new CliError('Voce precisa fazer login primeiro: zenifra auth login');
}

async function prompt(question, defaultValue) {
  const separator = question.trimEnd().endsWith('>') ? ' ' : ': ';
  if (!process.stdin.isTTY) {
    if (!pipedInputPromise) {
      pipedInputPromise = (async () => {
        const chunks = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        return Buffer.concat(chunks).toString('utf8').replace(/\r\n/g, '\n').split('\n');
      })();
    }
    const suffix = defaultValue ? ` (${defaultValue})` : '';
    process.stdout.write(`${question}${suffix}${separator}`);
    const lines = await pipedInputPromise;
    if (pipedInputIndex >= lines.length) {
      throw new CliError('Entrada interativa incompleta para o wizard.');
    }
    const answer = lines[pipedInputIndex] ?? '';
    pipedInputIndex += 1;
    process.stdout.write('\n');
    return answer.trim() || defaultValue || '';
  }

  if (!promptInterface) {
    promptInterface = readline.createInterface({ input: process.stdin, output: process.stdout });
  }
  const suffix = defaultValue ? ` (${defaultValue})` : '';
  const answer = await promptInterface.question(`${question}${suffix}${separator}`);
  return answer.trim() || defaultValue || '';
}

function shouldUseAnsi() {
  return Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
}

function tone(value, color) {
  return shouldUseAnsi() ? `${ANSI[color]}${value}${ANSI.reset}` : value;
}

function toneDim(value) {
  return shouldUseAnsi() ? `${ANSI.dim}${value}${ANSI.reset}` : value;
}

function estimateWizardTotal(state = {}) {
  const typeProject = state.typeProject;
  if (!typeProject) return 18;

  let total = 6;
  if (typeProject === 'http') {
    total += 3;

    if (state.plan !== 'free') {
      total += 2;
      if (state.httpStoragePersistent) total += 1;
    }

    if (state.planAllowsAutoscaling) {
      total += 1;
      if (state.httpAutoscalingEnabled) total += 3;
    }

    total += 1;
    if (state.envs?.enabled) total += state.envs.count * 3;

    total += 1;

    if (state.httpSource === 'github') {
      total += 9;
    } else if (state.httpSource === 'oci') {
      total += 2;
      if (state.httpImagePublic === false) {
        total += 1;
        if (state.httpImageAuthType === 'username_password') total += 2;
        if (state.httpImageAuthType === 'aws') total += 4;
      }
    } else {
      total += 1;
    }

    if (state.httpExposure !== 'private' && state.planAllowsBlockIp) {
      total += 2;
      if (state.whitelist?.enabled) total += state.whitelist.count * 3;
      if (state.blacklist?.enabled) total += state.blacklist.count * 3;
    }

    if (state.httpExposure !== 'private' && state.planAllowsSubdomain) total += 1;
    return total;
  }

  if (typeProject === 'postgresql') {
    total += 2;
    if (state.plan !== 'db-free') total += 1;
    return total;
  }

  if (typeProject === 'mariadb') {
    total += 2;
    return total;
  }

  if (typeProject === 'valkey') {
    total += 3;
    return total;
  }

  return 18;
}

function createWizardUi(state = {}) {
  return { step: 0, total: estimateWizardTotal(state), state };
}

function refreshWizardTotal(ui) {
  ui.total = Math.max(ui.step, estimateWizardTotal(ui.state));
  return ui.total;
}

function nextWizardStep(ui) {
  refreshWizardTotal(ui);
  ui.step += 1;
  if (ui.step > ui.total) ui.total = ui.step;
  return ui.step;
}

function isHelpRequest(value) {
  return ['?', 'help', 'ajuda'].includes(normalizeFreeText(value));
}

function formatInlineOptions(options, maxVisible = 4) {
  const values = options.map((option, index) => `${index + 1}=${option.value}`);
  if (values.length <= maxVisible) return values.join(' ');
  return `${values.slice(0, maxVisible - 1).join(' ')} ... ${values.at(-1)}`;
}

function printWizardFieldHelp({ label, required = false, examples = [], docs, allowedValues = [], options = [] }) {
  process.stdout.write(`\n${tone(`Ajuda: ${label}`, 'cyan')}\n`);
  process.stdout.write(`  obrigatorio: ${required ? 'sim' : 'nao'}\n`);
  if (allowedValues.length) process.stdout.write(`  valores: ${allowedValues.join(', ')}\n`);
  if (options.length) process.stdout.write(`  opcoes: ${options.map((option, index) => `${index + 1}=${option.value}`).join(' | ')}\n`);
  if (examples.length) process.stdout.write(`  exemplo: ${examples.join(' | ')}\n`);
  if (docs) process.stdout.write(`  docs: ${docs}\n`);
}

function buildWizardPromptLine({ ui, label, required = false, examples = [], options = [], kind = 'text', fixedValue = null }) {
  const step = nextWizardStep(ui);
  const stepText = toneDim(`[${step}/${ui.total}]`);
  const requiredText = required ? tone('*', 'yellow') : '';
  let suffix = '';

  if (kind === 'boolean') suffix = toneDim('[s/n]');
  else if (kind === 'select') suffix = toneDim(`[${formatInlineOptions(options)}]`);
  else if (fixedValue !== null) suffix = toneDim(`[fixo=${fixedValue}]`);
  else if (examples.length) suffix = toneDim(`(ex: ${examples[0]})`);

  return `${stepText} ${tone(label, 'bold')}${requiredText}${suffix ? ` ${suffix}` : ''} >`;
}

function isAffirmative(value) {
  return ['s', 'sim', 'y', 'yes'].includes(normalizeFreeText(value));
}

function isNegative(value) {
  return ['n', 'nao', 'não', 'no'].includes(normalizeFreeText(value));
}

function parsePositiveInteger(value) {
  const number = Number(String(value).trim());
  if (!Number.isInteger(number) || number <= 0) return null;
  return number;
}

function parseOptionalNullableCommand(value) {
  const normalized = normalizeFreeText(value);
  if (!normalized) return null;
  if (normalized === 'none' || normalized === 'null') return null;
  return String(value).trim();
}

function hasWizardCreateInput(flags) {
  return !flags.name && !flags.plan && !flags.paymentMode && !flags.config && !flags.description;
}

async function promptWizardText({ label, required = false, examples = [], docs, allowedValues = [], normalize, validate, emptyValue = '' }) {
  while (true) {
    const answer = await prompt(buildWizardPromptLine({
      ui: promptWizardText.ui,
      label,
      required,
      examples,
      kind: 'text',
    }));

    if (isHelpRequest(answer)) {
      printWizardFieldHelp({ label, required, examples, docs, allowedValues });
      promptWizardText.ui.step -= 1;
      continue;
    }

    if (!answer) {
      if (!required) return emptyValue;
      process.stdout.write(`${tone('valor obrigatorio.', 'red')}\n`);
      promptWizardText.ui.step -= 1;
      continue;
    }

    const normalized = normalize ? normalize(answer) : String(answer).trim();
    const error = validate ? validate(normalized, answer) : null;
    if (error) {
      process.stdout.write(`${tone(`valor invalido: ${error}`, 'red')}\n`);
      promptWizardText.ui.step -= 1;
      continue;
    }
    return normalized;
  }
}

async function promptWizardSecret({ label, required = false, examples = [], docs, allowedValues = [] }) {
  while (true) {
    const promptLine = buildWizardPromptLine({
      ui: promptWizardSecret.ui,
      label,
      required,
      examples,
      kind: 'text',
    });
    const answer = String(await promptHidden(promptLine)).trim();
    if (isHelpRequest(answer)) {
      printWizardFieldHelp({ label, required, examples, docs, allowedValues });
      promptWizardSecret.ui.step -= 1;
      continue;
    }
    if (!answer) {
      if (!required) return '';
      process.stdout.write(`${tone('valor obrigatorio.', 'red')}\n`);
      promptWizardSecret.ui.step -= 1;
      continue;
    }
    return answer;
  }
}

async function promptWizardBoolean({ label, docs, examples = ['sim', 'nao'] }) {
  while (true) {
    const answer = await prompt(buildWizardPromptLine({
      ui: promptWizardBoolean.ui,
      label,
      required: true,
      examples,
      kind: 'boolean',
    }));
    if (isHelpRequest(answer)) {
      printWizardFieldHelp({ label, required: true, examples, docs });
      promptWizardBoolean.ui.step -= 1;
      continue;
    }
    if (isAffirmative(answer)) return true;
    if (isNegative(answer)) return false;
    process.stdout.write(`${tone('valor invalido: responda com "s" ou "n".', 'red')}\n`);
    promptWizardBoolean.ui.step -= 1;
  }
}

async function promptWizardSelect({ label, options, docs, examples = [], extraValues = [] }) {
  while (true) {
    const allowedValues = [...options.map((option) => option.value), ...extraValues];
    const answer = await prompt(buildWizardPromptLine({
      ui: promptWizardSelect.ui,
      label,
      required: true,
      examples,
      kind: 'select',
      options,
    }));
    if (isHelpRequest(answer)) {
      printWizardFieldHelp({ label, required: true, examples, docs, allowedValues, options });
      promptWizardSelect.ui.step -= 1;
      continue;
    }
    const numericIndex = Number(answer);
    if (Number.isInteger(numericIndex) && numericIndex >= 1 && numericIndex <= options.length) {
      return options[numericIndex - 1].value;
    }
    const normalized = normalizeFreeText(answer);
    const found = options.find((option) => normalizeFreeText(option.value) === normalized);
    if (found) return found.value;
    const extraValue = extraValues.find((value) => normalizeFreeText(value) === normalized);
    if (extraValue) return extraValue;
    process.stdout.write(`${tone(`valor invalido: escolha um item entre ${options.map((_, index) => index + 1).join(', ')} ou um dos valores aceitos.`, 'red')}\n`);
    promptWizardSelect.ui.step -= 1;
  }
}

async function promptWizardNumber({ label, docs, examples = [], min = 1, max = Number.MAX_SAFE_INTEGER, fixedValue = null }) {
  while (true) {
    const allowedValues = fixedValue === null ? [] : [String(fixedValue)];
    const answer = await prompt(buildWizardPromptLine({
      ui: promptWizardNumber.ui,
      label,
      required: true,
      examples,
      kind: 'number',
      fixedValue,
    }));
    if (isHelpRequest(answer)) {
      printWizardFieldHelp({ label, required: true, examples, docs, allowedValues });
      promptWizardNumber.ui.step -= 1;
      continue;
    }
    const value = parsePositiveInteger(answer);
    if (value === null) {
      process.stdout.write(`${tone('valor invalido: informe um inteiro positivo.', 'red')}\n`);
      promptWizardNumber.ui.step -= 1;
      continue;
    }
    if (value < min || value > max || (fixedValue !== null && value !== fixedValue)) {
      process.stdout.write(`${tone(`valor invalido: informe um inteiro entre ${min} e ${max}${fixedValue !== null ? ` e igual a ${fixedValue}` : ''}.`, 'red')}\n`);
      promptWizardNumber.ui.step -= 1;
      continue;
    }
    return value;
  }
}

async function promptWizardPairs({ introLabel, itemLabels, docs, examples = [], stateKey = '' }) {
  const items = [];
  const ui = promptWizardBoolean.ui;
  const wantsAny = await promptWizardBoolean({ label: introLabel, docs, examples: ['sim', 'nao'] });
  if (stateKey) ui.state[stateKey] = { enabled: wantsAny, count: wantsAny ? 1 : 0 };
  if (!wantsAny) return items;

  while (true) {
    const item = {};
    for (const field of itemLabels) {
      item[field.key] = await promptWizardText(field);
    }
    items.push(item);
    const addMore = await promptWizardBoolean({ label: 'Deseja adicionar mais um item?', docs, examples: ['sim', 'nao'] });
    if (!addMore) break;
    if (stateKey) ui.state[stateKey].count += 1;
  }

  return items;
}

function closePromptResources() {
  if (promptInterface) {
    promptInterface.close();
    promptInterface = undefined;
  }
  if (process.stdin.isTTY) {
    process.stdin.removeAllListeners('data');
    process.stdin.removeAllListeners('keypress');
    process.stdin.pause();
    if (typeof process.stdin.setRawMode === 'function') {
      try {
        process.stdin.setRawMode(false);
      } catch {
        // ignore cleanup failures when stdin is already detached
      }
    }
  }
  pipedInputPromise = undefined;
  pipedInputIndex = 0;
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

    const separator = question.trimEnd().endsWith('>') ? ' ' : ': ';
    process.stdout.write(`${question}${separator}`);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

function httpTimeoutMs() {
  const configured = process.env.ZENIFRA_HTTP_TIMEOUT_MS;
  if (configured === undefined) return DEFAULT_HTTP_TIMEOUT_MS;

  const value = Number(configured);
  if (!Number.isInteger(value) || value <= 0) {
    throw new CliError('ZENIFRA_HTTP_TIMEOUT_MS deve ser um inteiro positivo em milissegundos.');
  }
  return value;
}

function publicApiErrorMessage(value) {
  const message = String(value || 'Nao foi possivel concluir a operacao.');
  if (/kubernetes|k8s|namespace|cluster|pod|serviceaccount|deployment|internal[_ -]/i.test(message)) {
    return 'Nao foi possivel concluir a operacao. Tente novamente mais tarde.';
  }
  return message;
}

async function request(session, flags, method, path, {
  body,
  orgId,
  tokenRequired = true,
  credential: credentialOverride,
  headers: extraHeaders = {},
} = {}) {
  const credential = credentialOverride || resolveCredential(session);
  if (tokenRequired && !credential) {
    throw new CliError('Voce precisa autenticar primeiro: zenifra auth login, zenifra auth api-key --key <znf_key> ou ZENIFRA_API_KEY.');
  }

  const headers = { Accept: 'application/json' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  for (const [name, value] of Object.entries(extraHeaders)) {
    if (value === undefined) continue;
    const normalizedName = name.toLowerCase();
    if (['authorization', 'x-organization-id', 'content-type'].includes(normalizedName)) {
      throw new CliError(`Header nao permitido: ${name}.`);
    }
    headers[name] = String(value);
  }
  if (credential?.token) {
    headers.Authorization = `Bearer ${credential.token}`;
  }
  if (orgId && credential?.type !== 'api_key') {
    headers['x-organization-id'] = orgId;
  }

  const timeoutMs = httpTimeoutMs();
  let response;
  try {
    response = await fetch(`${apiBaseUrl(session, flags)}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new CliError(`A API da Zenifra nao respondeu em ate ${timeoutMs} ms.`);
    }
    throw new CliError(`Nao foi possivel conectar a API da Zenifra: ${error?.message || 'erro de rede'}.`);
  }

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
    const message = publicApiErrorMessage(payload?.message || payload?.error || `Zenifra API retornou HTTP ${response.status}`);
    if (response.status === 401) {
      if (credential?.type === 'api_key') {
        throw new CliError(`${message}. Verifique se a API key esta ativa e se o IP atual esta permitido.`);
      }
      throw new CliError(`${message}. Rode "zenifra auth login" para renovar sua sessao.`);
    }
    if (response.status === 403) {
      throw new CliError(message);
    }
    if (response.status === 429 && Number.isFinite(Number(payload?.retry_after_seconds))) {
      throw new CliError(`${message} Tente novamente em ${Number(payload.retry_after_seconds)} segundo(s).`);
    }
    if (response.status === 402 && path.includes('/metrics') && /support metrics/i.test(String(message))) {
      throw new CliError('Este projeto nao possui acesso a metricas.');
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

function formatValkeyNumber(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'indisponivel';
  return String(value);
}

function formatValkeyBytes(value, suffix = '') {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'indisponivel';

  const numericValue = Number(value);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unitIndex = 0;
  let normalizedValue = numericValue;
  while (normalizedValue >= 1024 && unitIndex < units.length - 1) {
    normalizedValue /= 1024;
    unitIndex += 1;
  }

  const digits = normalizedValue >= 100 ? 0 : normalizedValue >= 10 ? 1 : 2;
  const formattedValue = Number(normalizedValue.toFixed(digits)).toString();
  return `${formattedValue} ${units[unitIndex]}${suffix}`;
}

function formatValkeyPercent(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'indisponivel';
  return `${Number((Number(value) * 100).toFixed(2))}%`;
}

function valkeyMetricRows(metrics) {
  const native = metrics?.valkey;
  const rows = [
    { field: 'Instancia', value: metrics?.instance || '-' },
    { field: 'Disponibilidade', value: metrics?.availability || 'indisponivel' },
    { field: 'Observado em', value: metrics?.observed_at || 'indisponivel' },
    { field: 'CPU', value: formatValkeyNumber(metrics?.cpu) },
    { field: 'Memoria', value: formatValkeyBytes(metrics?.memory) },
  ];

  if (!native) {
    rows.push({ field: 'Metricas Valkey', value: 'indisponivel' });
    return rows;
  }

  rows.push(
    { field: 'Perfil', value: native.profile || '-' },
    { field: 'Memoria usada', value: formatValkeyBytes(native.memory?.used_bytes) },
    { field: 'Pico de memoria', value: formatValkeyBytes(native.memory?.peak_bytes) },
    { field: 'Limite de memoria', value: formatValkeyBytes(native.memory?.limit_bytes) },
    { field: 'Fragmentacao', value: formatValkeyNumber(native.memory?.fragmentation_ratio) },
    { field: 'Clientes conectados', value: formatValkeyNumber(native.clients?.connected) },
    { field: 'Clientes bloqueados', value: formatValkeyNumber(native.clients?.blocked) },
    { field: 'Operacoes por segundo', value: formatValkeyNumber(native.activity?.operations_per_second) },
    { field: 'Entrada', value: formatValkeyBytes(native.activity?.input_bytes_per_second, '/s') },
    { field: 'Saida', value: formatValkeyBytes(native.activity?.output_bytes_per_second, '/s') },
    { field: 'Chaves expiradas', value: formatValkeyNumber(native.keys?.expired_total) },
    { field: 'Chaves removidas', value: formatValkeyNumber(native.keys?.evicted_total) },
    { field: 'Uptime', value: `${formatValkeyNumber(native.uptime_seconds)} s` },
  );

  if (native.cache) {
    rows.push(
      { field: 'Cache hits', value: formatValkeyNumber(native.cache.hits_total) },
      { field: 'Cache misses', value: formatValkeyNumber(native.cache.misses_total) },
      { field: 'Hit ratio', value: formatValkeyPercent(native.cache.hit_ratio) },
    );
  }

  if (native.key_value) {
    rows.push(
      { field: 'Total de chaves', value: formatValkeyNumber(native.key_value.keys_total) },
      { field: 'Chaves com expiracao', value: formatValkeyNumber(native.key_value.keys_with_expiration) },
    );
  }

  if (native.reliability) {
    const replication = native.reliability.replication;
    const persistence = native.reliability.persistence;
    if (replication) {
      rows.push(
        { field: 'Replicacao', value: replication.status || 'indisponivel' },
        { field: 'Repl. disponiveis', value: formatValkeyNumber(replication.replicas_available) },
        { field: 'Repl. esperadas', value: formatValkeyNumber(replication.replicas_expected) },
        { field: 'Lag', value: replication.lag_seconds === null || replication.lag_seconds === undefined ? 'indisponivel' : `${replication.lag_seconds} s` },
      );
    }
    if (persistence) {
      rows.push(
        { field: 'Persistencia', value: persistence.status || 'indisponivel' },
        { field: 'Persistencia ativa', value: persistence.enabled === null || persistence.enabled === undefined ? 'indisponivel' : persistence.enabled ? 'sim' : 'nao' },
        { field: 'Ultimo sucesso', value: persistence.last_success_at || 'indisponivel' },
      );
    }
  }

  return rows;
}

function printValkeyMetrics(metrics) {
  printTable(valkeyMetricRows(metrics), [
    { label: 'Campo', value: (row) => row.field },
    { label: 'Valor', value: (row) => row.value },
  ]);
}

function printMetricsCapabilities(capabilities) {
  const groups = Array.isArray(capabilities?.groups) && capabilities.groups.length > 0
    ? capabilities.groups.join(', ')
    : 'nenhum';
  const history = capabilities?.history
    ? `${capabilities.history.retention_seconds} s de retencao`
    : 'indisponivel';

  printTable([
    { field: 'Acesso', value: capabilities?.access || 'indisponivel' },
    { field: 'Grupos', value: groups },
    { field: 'Atualizacao', value: capabilities?.refresh_seconds === null || capabilities?.refresh_seconds === undefined ? 'indisponivel' : `${capabilities.refresh_seconds} s` },
    { field: 'Historico', value: history },
  ], [
    { label: 'Campo', value: (row) => row.field },
    { label: 'Valor', value: (row) => row.value },
  ]);
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

function buildLogLineOf(log) {
  const timestamp = log?.timestamp ? new Date(log.timestamp).toISOString() : new Date().toISOString()
  const step = log?.step || 'build'
  const message = log?.message || ''
  return `[${timestamp}] ${step}: ${message}`
}

function requireProjectId(flags, commandKey) {
  if (!flags.project || flags.project === true) {
    printCommandHelpAndFail(commandKey)
    return null
  }
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

function formatPublicUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

function printEnvs(envs, flags) {
  const output = envsForOutput(envs, { showValues: Boolean(flags.showValues) });
  if (flags.json) return printJson(output);
  printTable(output, [
    { label: 'Nome', value: (env) => env.name || '-' },
    { label: 'Valor', value: (env) => env.value || '-' },
  ]);
}

function isJobProject(project) {
  return project?.type_project === 'job' || project?.config?.type_project === 'job';
}

const JOB_INFO_HIDDEN_KEYS = new Set(['domain', 'url', 'exposure', 'port', 'instances']);
const JOB_CONFIG_HIDDEN_KEYS = new Set(['exposure', 'port', 'instances', 'network_access', 'domain', 'custom_domains', 'autoscaling', 'healthcheck']);
const INTERNAL_PROJECT_KEYS = new Set([
  'current_instances',
  'runtime_name',
  'namespace',
  'k8s_job_name',
]);

function sanitizePublicProjectValue(value) {
  if (Array.isArray(value)) return value.map(sanitizePublicProjectValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !INTERNAL_PROJECT_KEYS.has(key))
    .map(([key, entryValue]) => [key, sanitizePublicProjectValue(entryValue)]));
}

function sanitizeJobConfigInfo(value) {
  if (Array.isArray(value)) return value.map(sanitizeJobConfigInfo);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !JOB_CONFIG_HIDDEN_KEYS.has(key))
    .map(([key, entryValue]) => [key, sanitizeJobConfigInfo(entryValue)]));
}

function sanitizePublicProject(project) {
  const sanitized = sanitizePublicProjectValue(project);
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) return sanitized;
  return Object.fromEntries(Object.entries(sanitized)
    .filter(([key]) => !JOB_INFO_HIDDEN_KEYS.has(key))
    .map(([key, value]) => [key, key === 'config' ? sanitizeJobConfigInfo(value) : value]));
}

function sanitizeJobProjectResponse(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  if (payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) {
    return { ...payload, data: sanitizePublicProject(payload.data) };
  }
  return sanitizePublicProjectValue(payload);
}

function publicProjectsData(data) {
  if (Array.isArray(data)) return data.map((project) => isJobProject(project) ? sanitizePublicProject(project) : project);
  if (!data || typeof data !== 'object') return data;
  return {
    ...data,
    projects: Array.isArray(data.projects)
      ? data.projects.map((project) => isJobProject(project) ? sanitizePublicProject(project) : project)
      : data.projects,
  };
}

function printProject(project) {
  const managedService = project.managed_service;
  const isValkey = project.type_project === 'valkey' || managedService?.engine === 'valkey';
  const isJob = isJobProject(project);
  const rows = [
    { label: 'ID', value: projectIdOf(project) || '-' },
    { label: 'Nome', value: project.name || '-' },
    { label: 'Status', value: project.status || '-' },
    { label: 'Tipo', value: project.type_project || '-' },
    { label: 'Plano', value: project.plan || '-' },
  ];

  if (isJob) {
    const schedule = project.job || project.config?.job || {};
    rows.push(
      { label: 'Agendamento', value: schedule.cron || '-' },
      { label: 'Armazenamento', value: project.storage?.persistent === true || project.config?.storage?.persistent === true ? 'persistente' : 'efemero' },
    );
  } else if (isValkey) {
    rows.push(
      { label: 'Perfil', value: managedService?.profile || '-' },
      { label: 'Versao', value: managedService?.version || '-' },
      { label: 'Persistente', value: managedService?.topology?.persistent === true ? 'sim' : 'nao' },
      { label: 'Instancias', value: project.instances ?? '-' },
    );
  } else {
    rows.push(
      { label: 'Exposicao', value: project.exposure || '-' },
      { label: 'URL', value: projectUrlOf(project) || '-' },
      { label: 'Imagem', value: project.image || '-' },
      { label: 'Instancias', value: project.instances ?? '-' },
      { label: 'Instancias atuais', value: project.additional_info?.current_instances ?? '-' },
    );
  }

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
    await persistSession(session);
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
  await persistSession(session);
  return session.selectedOrganizationId;
}

async function handleLogin(session, flags) {
  const targetSession = ensureProfile(session, flags.profile, { activate: Boolean(flags.profile) || !getProfileName(session) });
  const email = String(flags.email || await prompt('Email'));
  const password = String(flags.password || await promptHidden('Senha'));

  const loginPayload = await request(targetSession, flags, 'PATCH', '/authentication', {
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

    payload = await request(targetSession, flags, 'POST', '/authentication/challenge/verify', {
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
    ...targetSession,
    accessToken,
    apiKey: undefined,
    authMode: 'access_token',
    apiBaseUrl: apiBaseUrl(targetSession, flags),
    selectedOrganizationId: targetSession.selectedOrganizationId,
    updatedAt: new Date().toISOString(),
  };

  nextSession.__store.activeProfile = nextSession.__profileName;
  await persistSession(nextSession);
  Object.assign(session, buildSession(nextSession.__store));
  process.stdout.write('Login realizado com sucesso.\n');
}

async function handleApiKeyLogin(session, flags) {
  const apiKey = String(flags.key || await promptHidden('API key Zenifra'));

  if (!apiKey.startsWith('znf_')) {
    throw new CliError('API key invalida. As API keys globais da Zenifra comecam com "znf_".');
  }

  const targetSession = ensureProfile(session, flags.profile, { activate: Boolean(flags.profile) || !getProfileName(session) });
  const nextSession = {
    ...targetSession,
    accessToken: undefined,
    selectedOrganizationId: undefined,
    apiKey,
    authMode: 'api_key',
    apiBaseUrl: apiBaseUrl(targetSession, flags),
    updatedAt: new Date().toISOString(),
  };

  nextSession.__store.activeProfile = nextSession.__profileName;
  await persistSession(nextSession);
  Object.assign(session, buildSession(nextSession.__store));
  process.stdout.write('API key salva com sucesso. Ela sera usada em comandos de automacao.\n');
}

async function handleLogout(session, flags) {
  const targetName = flags.profile || getProfileName(session);
  if (!targetName) {
    throw new CliError('Nenhum perfil ativo configurado. Crie um perfil com "zenifra profile add" ou autentique com "zenifra auth login".');
  }
  const target = requireExistingProfile(session, targetName);
  if (flags.revoke) {
    if (!target.accessToken) {
      throw new CliError('A revogacao exige um perfil autenticado por login de usuario; API keys devem ser revogadas na organizacao.');
    }
    await request(target, flags, 'DELETE', '/authentication', {
      credential: {
        token: target.accessToken,
        type: 'user',
        source: 'profile',
      },
    });
  }
  target.accessToken = undefined;
  target.apiKey = undefined;
  target.selectedOrganizationId = undefined;
  target.authMode = 'api_key';
  target.updatedAt = new Date().toISOString();
  await persistSession(target);
  if (target.__profileName === getProfileName(session)) {
    Object.assign(session, buildSession(target.__store));
  }
  process.stdout.write(`Autenticacao removida do perfil ${target.__profileName}${flags.revoke ? ' e sessoes de usuario revogadas' : ''}.\n`);
}

function maskApiKey(value) {
  if (!value) return '-';
  if (value.length <= 12) return '********';
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function profileOutput(profile, activeName) {
  return {
    name: profile.name,
    description: profile.description || '',
    auth_mode: profile.accessToken ? 'access_token' : profile.apiKey ? 'api_key' : profile.authMode || 'api_key',
    api_base_url: profile.apiBaseUrl || DEFAULT_API_BASE_URL,
    selected_organization_id: profile.selectedOrganizationId,
    has_api_key: Boolean(profile.apiKey),
    has_access_token: Boolean(profile.accessToken),
    api_key_masked: maskApiKey(profile.apiKey),
    active: profile.name === activeName,
    updated_at: profile.updatedAt,
  };
}

async function handleProfileList(session, flags) {
  const store = getStore(session);
  const profiles = Object.values(store.profiles)
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((profile) => profileOutput(profile, store.activeProfile));

  if (flags.json) return printJson(profiles);
  printTable(profiles, [
    { label: 'Nome', value: (profile) => profile.name },
    { label: 'Tipo', value: (profile) => profile.auth_mode },
    { label: 'API base', value: (profile) => profile.api_base_url },
    { label: 'Ativo', value: (profile) => (profile.active ? 'yes' : 'no') },
    { label: 'Descricao', value: (profile) => profile.description || '-' },
  ]);
}

async function handleProfileShow(session, flags, positional = []) {
  const targetName = positional[2] || flags.name || getProfileName(session);
  if (!targetName) {
    throw new CliError('Nenhum perfil ativo configurado.');
  }
  const target = requireExistingProfile(session, targetName);
  const output = profileOutput(target, target.__store.activeProfile);

  if (flags.json) return printJson(output);
  process.stdout.write(`Nome: ${output.name}\n`);
  process.stdout.write(`Descricao: ${output.description || '-'}\n`);
  process.stdout.write(`Tipo: ${output.auth_mode}\n`);
  process.stdout.write(`API base: ${output.api_base_url}\n`);
  process.stdout.write(`Ativo: ${output.active ? 'sim' : 'nao'}\n`);
  process.stdout.write(`API key: ${output.api_key_masked}\n`);
  process.stdout.write(`Token de login: ${output.has_access_token ? 'salvo' : '-'}\n`);
  process.stdout.write(`Organizacao ativa: ${output.selected_organization_id || '-'}\n`);
}

async function handleProfileUse(session, flags, positional = []) {
  const targetName = positional[2] || flags.name;
  if (!targetName) {
    printCommandHelpAndFail('profile use')
    return
  }
  activateProfileSession(session, targetName);
  await writeProfileStore(getStore(session));
  if (flags.json) return printJson({ active_profile: getProfileName(session) });
  process.stdout.write(`Perfil ativo: ${getProfileName(session)}\n`);
}

async function promptProfileAddInput(flags) {
  const name = normalizeProfileName(flags.name || await prompt('Nome do perfil'));
  const description = String(flags.description ?? await prompt('Descricao do perfil'));
  const apiBase = normalizeApiBaseUrl(flags.apiBase || await prompt('API base', DEFAULT_API_BASE_URL));
  const mode = normalizeFreeText(String(flags.mode || await prompt('Modo do perfil', 'api-key')));
  if (!['api-key', 'login'].includes(mode)) {
    throw new CliError('Modo de perfil invalido. Use "api-key" ou "login".');
  }
  return { name, description, apiBase, mode };
}

async function handleProfileAdd(session, flags) {
  const { name, description, apiBase, mode } = await promptProfileAddInput(flags);
  const targetSession = ensureProfile(session, name, { activate: true });
  targetSession.description = description;
  targetSession.apiBaseUrl = apiBase;
  if (mode === 'api-key') {
    const apiKey = String(flags.key || await promptHidden('API key Zenifra'));
    if (!apiKey.startsWith('znf_')) {
      throw new CliError('API key invalida. As API keys globais da Zenifra comecam com "znf_".');
    }
    targetSession.apiKey = apiKey;
    targetSession.accessToken = undefined;
    targetSession.selectedOrganizationId = undefined;
    targetSession.authMode = 'api_key';
    targetSession.updatedAt = new Date().toISOString();
    await persistSession(targetSession);
    Object.assign(session, buildSession(targetSession.__store));
  } else {
    targetSession.description = description;
    targetSession.apiBaseUrl = apiBase;
    targetSession.updatedAt = new Date().toISOString();
    await persistSession(targetSession);
    Object.assign(session, buildSession(targetSession.__store));
    await handleLogin(session, { ...flags, profile: name, apiBase });
  }
  const output = profileOutput(requireExistingProfile(session, name), getStore(session).activeProfile);
  if (flags.json) return printJson(output);
  process.stdout.write(`Perfil ${name} salvo e definido como ativo.\n`);
}

async function handleProfileEdit(session, flags, positional = []) {
  const targetName = positional[2] || flags.name;
  if (!targetName) {
    printCommandHelpAndFail('profile edit')
    return
  }
  const target = requireExistingProfile(session, targetName);
  target.description = String(flags.description ?? await prompt('Descricao do perfil', target.description || ''));
  target.apiBaseUrl = normalizeApiBaseUrl(flags.apiBase || await prompt('API base', target.apiBaseUrl || DEFAULT_API_BASE_URL));
  target.updatedAt = new Date().toISOString();
  await persistSession(target);
  if (target.__profileName === getProfileName(session)) {
    Object.assign(session, buildSession(target.__store));
  }
  const output = profileOutput(target, target.__store.activeProfile);
  if (flags.json) return printJson(output);
  process.stdout.write(`Perfil ${target.__profileName} atualizado.\n`);
}

async function handleProfileRemove(session, flags, positional = []) {
  const targetName = positional[2] || flags.name;
  if (!targetName) {
    printCommandHelpAndFail('profile remove')
    return
  }
  const normalizedName = normalizeProfileName(targetName);
  const store = getStore(session);
  if (!store.profiles[normalizedName]) {
    throw new CliError(`Perfil nao encontrado: ${normalizedName}`);
  }
  if (store.activeProfile === normalizedName) {
    throw new CliError('Nao e permitido remover o perfil ativo. Use "zenifra profile use <name>" para trocar antes.');
  }
  delete store.profiles[normalizedName];
  session.__store = await writeProfileStore(store);
  if (flags.json) return printJson({ removed: normalizedName });
  process.stdout.write(`Perfil ${normalizedName} removido.\n`);
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
    await persistSession(session);
    process.stdout.write(`Organizacao ativa: ${session.selectedOrganizationId}\n`);
    return;
  }

  const orgId = await resolveOrgId({ ...session, selectedOrganizationId: undefined }, flags, { interactive: true });
  process.stdout.write(`Organizacao ativa: ${orgId}\n`);
}

async function handleProjects(session, flags) {
  const orgId = await resolveOrgId(session, flags);
  const projectFlags = {
    ...flags,
    page: flags.page ?? 1,
    limit: flags.limit ?? 15,
  };
  const query = buildQuery(projectFlags, ['type', 'page', 'limit']);
  const data = unwrapData(await request(session, flags, 'GET', `/project${query}`, { orgId }));
  const publicData = publicProjectsData(data);
  const projects = asArray(publicData);

  if (flags.json) return printJson(publicData);
  printTable(projects, [
    { label: 'ID', value: projectIdOf },
    { label: 'Nome', value: (project) => project.name || '-' },
    { label: 'Status', value: (project) => project.status || '-' },
    { label: 'Plano', value: (project) => project.plan || '-' },
    { label: 'Tipo', value: (project) => project.type_project || project.config?.type_project || '-' },
  ]);
  if (data?.pagination) {
    const { page = 1, pages = 1, total = projects.length } = data.pagination;
    process.stdout.write(`\nPagina ${page} de ${Math.max(pages, 1)} (${total} projeto(s))\n`);
  }
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

function normalizeFreeText(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizePlan(value) {
  const raw = normalizeFreeText(value);
  if (!raw) return '';

  const normalized = raw
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  const aliases = new Map([
    ['premium_plus', 'premium_plus'],
    ['premiumplus', 'premium_plus'],
    ['deep_learning_basic', 'deep_learning_basic'],
    ['deeplearningbasic', 'deep_learning_basic'],
    ['deep_learning_premium', 'deep_learning_premium'],
    ['deeplearningpremium', 'deep_learning_premium'],
    ['db_free', 'db-free'],
    ['dbfree', 'db-free'],
    ['db_starter', 'db-starter'],
    ['dbstarter', 'db-starter'],
    ['db_basic', 'db-basic'],
    ['dbbasic', 'db-basic'],
    ['db_premium', 'db-premium'],
    ['dbpremium', 'db-premium'],
    ['db_enterprise', 'db-enterprise'],
    ['dbenterprise', 'db-enterprise'],
    ['cache_free', 'cache-free'],
    ['cachefree', 'cache-free'],
    ['cache_starter', 'cache-starter'],
    ['cachestarter', 'cache-starter'],
    ['cache_basic', 'cache-basic'],
    ['cachebasic', 'cache-basic'],
    ['cache_premium', 'cache-premium'],
    ['cachepremium', 'cache-premium'],
    ['cache_enterprise', 'cache-enterprise'],
    ['cacheenterprise', 'cache-enterprise'],
    ['queue_free', 'queue-free'],
    ['queuefree', 'queue-free'],
    ['queue_starter', 'queue-starter'],
    ['queuestarter', 'queue-starter'],
    ['queue_basic', 'queue-basic'],
    ['queuebasic', 'queue-basic'],
    ['queue_premium', 'queue-premium'],
    ['queuepremium', 'queue-premium'],
    ['queue_enterprise', 'queue-enterprise'],
    ['queueenterprise', 'queue-enterprise'],
  ]);

  if (aliases.has(normalized)) return aliases.get(normalized);
  if (ALLOWED_PLAN_VALUES.has(normalized)) return normalized;
  return normalized;
}

function normalizePaymentMode(value) {
  const raw = normalizeFreeText(value);
  const aliases = new Map([
    ['hourly', 'hourly'],
    ['por hora', 'hourly'],
    ['hora', 'hourly'],
    ['monthly', 'monthly'],
    ['month', 'monthly'],
    ['mensal', 'monthly'],
    ['por mes', 'monthly'],
    ['por mês', 'monthly'],
    ['yearly', 'yearly'],
    ['annual', 'yearly'],
    ['anual', 'yearly'],
    ['por ano', 'yearly'],
    ['per_minute', 'per_minute'],
    ['per-minute', 'per_minute'],
    ['por minuto', 'per_minute'],
    ['minuto', 'per_minute'],
  ]);
  return aliases.get(raw) || raw;
}

function normalizeTypeProject(value) {
  const raw = normalizeFreeText(value);
  const aliases = new Map([
    ['http', 'http'],
    ['api', 'http'],
    ['site', 'http'],
    ['postgres', 'postgresql'],
    ['postgresql', 'postgresql'],
    ['mariadb', 'mariadb'],
    ['maria db', 'mariadb'],
    ['valkey', 'valkey'],
    ['key value', 'valkey'],
    ['key-value', 'valkey'],
  ]);
  return aliases.get(raw) || raw;
}

function normalizeValkeyProfile(value) {
  const raw = normalizeFreeText(value);
  const aliases = new Map([
    ['key_value', 'key_value'],
    ['key value', 'key_value'],
    ['key-value', 'key_value'],
    ['cache', 'cache'],
    ['queue', 'queue'],
  ]);
  return aliases.get(raw) || raw;
}

function normalizeExposure(value) {
  const raw = normalizeFreeText(value);
  const aliases = new Map([
    ['public', 'public'],
    ['publico', 'public'],
    ['público', 'public'],
    ['exposto', 'public'],
    ['sim', 'public'],
    ['private', 'private'],
    ['privado', 'private'],
    ['nao', 'private'],
    ['não', 'private'],
  ]);
  return aliases.get(raw) || raw;
}

function normalizeRuntime(value) {
  const raw = normalizeFreeText(value);
  const aliases = new Map([
    ['node', 'nodejs'],
    ['nodejs', 'nodejs'],
    ['node.js', 'nodejs'],
    ['python', 'python'],
  ]);
  return aliases.get(raw) || raw;
}

function wizardPlanOptionsForTypeProject(typeProject) {
  if (typeProject === 'http') return WIZARD_HTTP_PLAN_OPTIONS;
  if (typeProject === 'postgresql') return WIZARD_DATABASE_PLAN_OPTIONS;
  if (typeProject === 'mariadb') return WIZARD_DATABASE_PLAN_OPTIONS.filter((value) => value !== 'db-free');
  return WIZARD_HTTP_PLAN_OPTIONS;
}

function sortWizardOptions(values, preferredOrder) {
  const order = new Map(preferredOrder.map((value, index) => [value, index]));
  return [...values].sort((left, right) => (order.get(left) ?? Number.MAX_SAFE_INTEGER) - (order.get(right) ?? Number.MAX_SAFE_INTEGER));
}

function getPlanFeatures(planCatalog, planId) {
  return Array.isArray(planCatalog)
    ? planCatalog.find((plan) => plan?.plan === planId)?.features || []
    : [];
}

function planHasFeature(planCatalog, planId, snippet) {
  return getPlanFeatures(planCatalog, planId).some((feature) => String(feature).includes(snippet));
}

function isSubdomainCustomizable(planCatalog, planId) {
  return planHasFeature(planCatalog, planId, 'Sub-domínio HTTP personalizado');
}

function isIpAccessEnabled(planCatalog, planId) {
  return planHasFeature(planCatalog, planId, 'Bloqueio de IPs');
}

function isAutoscalingEnabledForPlan(planCatalog, planId) {
  const plan = Array.isArray(planCatalog)
    ? planCatalog.find((item) => item?.plan === planId)
    : undefined;
  return plan?.permissions?.allow_autoscaling === 'true';
}

function getMaxReplicasFromFeatures(features) {
  const replicaFeature = features.find((feature) => /réplicas?/i.test(String(feature)));
  if (!replicaFeature) return 5;
  const match = String(replicaFeature).match(/até\s+(\d+)/i) || String(replicaFeature).match(/(\d+)\s+réplicas?/i);
  return match ? Number(match[1]) : 5;
}

function requireWizardCatalogArray(value, label) {
  if (!Array.isArray(value)) {
    throw new CliError(`Falha ao carregar ${label} para o wizard. Tente novamente mais tarde.`);
  }
  return value;
}

function requireWizardCatalogObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CliError(`Falha ao carregar ${label} para o wizard. Tente novamente mais tarde.`);
  }
  return value;
}

async function fetchWizardCatalogs(session, flags) {
  const httpPlans = requireWizardCatalogArray(
    unwrapData(await request(session, flags, 'GET', '/project/plans')),
    'os planos HTTP',
  );
  const availableInstances = requireWizardCatalogObject(
    unwrapData(await request(session, flags, 'GET', '/projects/available')),
    'as instancias disponiveis',
  );
  const databasePlans = requireWizardCatalogArray(
    unwrapData(await request(session, flags, 'GET', '/project/database/plans')),
    'os planos de banco',
  );
  return { httpPlans, availableInstances, databasePlans };
}

function requireJobPlans(value) {
  const plans = Array.isArray(value) ? value : value?.plans;
  if (!Array.isArray(plans)) {
    throw new CliError('Falha ao carregar o catalogo de Jobs agendados. Tente novamente mais tarde.');
  }
  return plans;
}

function normalizePlansCatalogType(value) {
  const normalized = normalizeFreeText(value || 'all');
  if (!normalized || normalized === 'all') return 'all';
  if (normalized === 'http') return 'http';
  if (['database', 'db', 'postgresql', 'mariadb'].includes(normalized)) return 'database';
  if (normalized === 'valkey') return 'valkey';
  if (normalized === 'job' || normalized === 'jobs' || normalized === 'scheduled job' || normalized === 'scheduled jobs') return 'job';
  if (normalized === 'key-value' || normalized === 'key value' || normalized === 'key_value') return 'valkey-key_value';
  if (normalized === 'cache') return 'valkey-cache';
  if (normalized === 'queue') return 'valkey-queue';
  if (normalized === 'storage') return 'storage';
  return null;
}

function formatBrl(value) {
  const number = Number(value ?? 0);
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(Number.isFinite(number) ? number : 0);
}

function formatBrlFromCents(value) {
  const number = Number(value ?? 0);
  return formatBrl(Number.isFinite(number) ? number / 100 : 0);
}

function humanizeStorageName(value) {
  const raw = String(value || '').trim();
  if (!raw) return { storage: '-', type: '-' };

  const normalized = normalizeFreeText(raw)
    .replaceAll('ê', 'e')
    .replaceAll('_', ' ');
  const gbMatch = normalized.match(/(\d+)\s*gb/);
  const size = gbMatch ? `${gbMatch[1]} GB` : raw;

  if (normalized.includes('persistente')) {
    return { storage: size, type: 'Persistente' };
  }
  if (normalized.includes('efemero')) {
    return { storage: size, type: 'Efemero' };
  }

  return { storage: raw, type: '-' };
}

const VALKEY_PROFILE_LABELS = {
  key_value: 'Key Value',
  cache: 'Cache',
  queue: 'Queue',
};

function requireValkeyCatalog(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.engine !== 'valkey'
    || typeof value.version !== 'string'
    || typeof value.currency !== 'string'
    || !Array.isArray(value.profiles)
    || !Array.isArray(value.plans)
    || value.profiles.length === 0
    || value.plans.length === 0) {
    throw new CliError('Falha ao carregar o catalogo Valkey. Tente novamente mais tarde.');
  }

  const validProfiles = new Set(Object.keys(VALKEY_PROFILE_LABELS));
  if (value.profiles.some((profile) => !validProfiles.has(profile?.id) || typeof profile.persistence !== 'boolean')) {
    throw new CliError('Falha ao carregar o catalogo Valkey. Tente novamente mais tarde.');
  }
  if (value.plans.some((plan) => !validProfiles.has(plan?.profile) || typeof plan.id !== 'string' || !plan.prices || typeof plan.prices !== 'object')) {
    throw new CliError('Falha ao carregar o catalogo Valkey. Tente novamente mais tarde.');
  }

  return value;
}

function valkeyProfileFilter(type) {
  if (!type.startsWith('valkey-')) return null;
  return type.slice('valkey-'.length);
}

function filterValkeyCatalog(catalog, profile) {
  if (!profile) return catalog;
  return {
    ...catalog,
    profiles: catalog.profiles.filter((entry) => entry.id === profile),
    plans: catalog.plans.filter((plan) => plan.profile === profile),
  };
}

async function fetchPlansCatalogs(session, flags, type) {
  if (type === 'http') {
    return {
      http: requireWizardCatalogArray(
        unwrapData(await request(session, flags, 'GET', '/project/plans', { tokenRequired: false })),
        'os planos HTTP',
      ),
      database: [],
      storage: [],
    };
  }

  if (type === 'database') {
    return {
      http: [],
      database: requireWizardCatalogArray(
        unwrapData(await request(session, flags, 'GET', '/project/database/plans', { tokenRequired: false })),
        'os planos de banco',
      ),
      storage: [],
    };
  }

  if (type === 'storage') {
    return {
      http: [],
      database: [],
      storage: requireWizardCatalogArray(
        unwrapData(await request(session, flags, 'GET', '/project/storage/plans', { tokenRequired: false })),
        'os planos de storage',
      ),
    };
  }

  if (type === 'job') {
    return {
      http: [],
      database: [],
      storage: [],
      job: requireJobPlans(
        unwrapData(await request(session, flags, 'GET', '/project/job/plans', { tokenRequired: false })),
      ),
    };
  }

  if (type === 'valkey' || type.startsWith('valkey-')) {
    const catalog = requireValkeyCatalog(
      unwrapData(await request(session, flags, 'GET', '/managed-services/catalog', { tokenRequired: false })),
    );
    return {
      http: [],
      database: [],
      storage: [],
      valkey: filterValkeyCatalog(catalog, valkeyProfileFilter(type)),
    };
  }

  const [httpPayload, databasePayload, storagePayload, valkeyPayload] = await Promise.all([
    request(session, flags, 'GET', '/project/plans', { tokenRequired: false }),
    request(session, flags, 'GET', '/project/database/plans', { tokenRequired: false }),
    request(session, flags, 'GET', '/project/storage/plans', { tokenRequired: false }),
    request(session, flags, 'GET', '/managed-services/catalog', { tokenRequired: false }),
  ]);

  return {
    http: requireWizardCatalogArray(unwrapData(httpPayload), 'os planos HTTP'),
    database: requireWizardCatalogArray(unwrapData(databasePayload), 'os planos de banco'),
    storage: requireWizardCatalogArray(unwrapData(storagePayload), 'os planos de storage'),
    valkey: requireValkeyCatalog(unwrapData(valkeyPayload)),
  };
}

function printValkeyCatalog(catalog, profileFilter) {
  const profiles = profileFilter ? [profileFilter] : Object.keys(VALKEY_PROFILE_LABELS);
  profiles.forEach((profile, index) => {
    if (index > 0) process.stdout.write('\n');
    process.stdout.write(`${VALKEY_PROFILE_LABELS[profile]}\n`);
    const plans = catalog.plans.filter((plan) => plan.profile === profile);
    printTable(plans, [
      { label: 'Plano', value: (plan) => plan.id || '-' },
      { label: 'Hora', value: (plan) => formatBrl(plan.prices?.hourly, catalog.currency) },
      { label: 'Mes', value: (plan) => formatBrl(plan.prices?.monthly, catalog.currency) },
      { label: 'Ano', value: (plan) => formatBrl(plan.prices?.yearly, catalog.currency) },
      { label: 'Capacidade', value: (plan) => `${plan.resources?.cpu || '-'} / ${plan.resources?.memory || '-'}` },
      { label: 'Storage incluído', value: (plan) => `${plan.included_storage_gb ?? 0} GB` },
      { label: 'Alta disponibilidade', value: (plan) => plan.high_availability?.[profile] ? 'sim' : 'nao' },
    ]);
  });
}

function printJobCatalog(plans) {
  process.stdout.write('Jobs agendados' + String.fromCharCode(10));
  printTable(asArray(plans), [
    { label: 'Plano', value: (plan) => plan.plan || plan.id || '-' },
    { label: 'Por minuto', value: (plan) => formatBrlFromCents(plan.unit_amount ?? plan.prices?.per_minute) },
    { label: 'Features', value: (plan) => asArray(plan.features).join(', ') || '-' },
  ]);
}

function printPlansCatalogs(payload, type) {
  if (type === 'all' || type === 'http') {
    process.stdout.write('HTTP\n');
    printTable(asArray(payload.http), [
      { label: 'Plano', value: (plan) => plan.plan || '-' },
      { label: 'Hora', value: (plan) => formatBrlFromCents(plan.prices?.hourly) },
      { label: 'Mes', value: (plan) => formatBrlFromCents(plan.prices?.monthly) },
      { label: 'Ano', value: (plan) => formatBrlFromCents(plan.prices?.yearly) },
      { label: 'Recursos', value: (plan) => asArray(plan.features).join(', ') || '-' },
    ]);
  }

  if (type === 'all' || type === 'database') {
    if (type === 'all') process.stdout.write('\n');
    process.stdout.write('PostgreSQL / MariaDB\n');
    printTable(asArray(payload.database), [
      { label: 'Plano', value: (plan) => plan.plan || '-' },
      { label: 'Hora', value: (plan) => formatBrlFromCents(plan.prices?.hourly) },
      { label: 'Mes', value: (plan) => formatBrlFromCents(plan.prices?.monthly) },
      { label: 'Ano', value: (plan) => formatBrlFromCents(plan.prices?.yearly) },
      { label: 'Recursos', value: (plan) => asArray(plan.features).join(', ') || '-' },
    ]);
  }

  if (type === 'all' || type === 'storage') {
    if (type === 'all') process.stdout.write('\n');
    process.stdout.write('Armazenamento\n');
    printTable(asArray(payload.storage), [
      { label: 'Storage', value: (storage) => humanizeStorageName(storage.storage).storage },
      { label: 'Tipo', value: (storage) => humanizeStorageName(storage.storage).type },
      { label: 'Hora', value: (storage) => formatBrl(storage.prices?.hourly) },
      { label: 'Mes', value: (storage) => formatBrl(storage.prices?.monthly) },
      { label: 'Ano', value: (storage) => formatBrl(storage.prices?.yearly) },
    ]);
  }

  if (type === 'job') {
    printJobCatalog(payload.job);
    return;
  }

  if (type === 'all' || type === 'valkey' || type.startsWith('valkey-')) {
    if (type === 'all') process.stdout.write('\n');
    printValkeyCatalog(payload.valkey, valkeyProfileFilter(type));
  }
}

async function handlePlans(session, flags) {
  const type = normalizePlansCatalogType(flags.type);
  if (!type) {
    throw new CliError('Tipo de catalogo invalido. Valores aceitos: all, http, database, storage, valkey ou job.');
  }

  const payload = await fetchPlansCatalogs(session, flags, type);
  if (flags.json) return printJson(payload);
  printPlansCatalogs(payload, type);
}

function formatAllowedValues(values) {
  return [...values].join(', ');
}

function validateJobConfig(config) {
  if (!isRecord(config)) throw new CliError('config deve ser um objeto.');

  if (!isRecord(config.job)) throw new CliError('Jobs exigem config.job.');
  const cron = String(config.job.cron || '').trim();
  if (cron.split(/\s+/).filter(Boolean).length !== 5) {
    throw new CliError('config.job.cron deve conter exatamente cinco campos em UTC.');
  }
  const forbiddenFields = ['instances', 'port', 'exposure', 'network_access', 'domain', 'custom_domains', 'autoscaling', 'healthcheck'];
  const forbiddenField = forbiddenFields.find((field) => config[field] !== undefined);
  if (forbiddenField) {
    throw new CliError(`Jobs nao aceitam config.${forbiddenField}.`);
  }
  const forbiddenJobField = ['command', 'args'].find((field) => config.job[field] !== undefined);
  if (forbiddenJobField) {
    throw new CliError(`Jobs nao aceitam config.job.${forbiddenJobField}. A imagem ja define o comando e os argumentos.`);
  }

  if (!isRecord(config.image) || typeof config.image.url !== 'string' || !config.image.url.trim()) {
    throw new CliError('Jobs exigem uma imagem OCI em config.image. O fluxo GitHub ainda nao esta disponivel para Jobs.');
  }
  const imageReference = config.image.url.trim();
  if (imageReference.length < OCI_IMAGE_REFERENCE_MIN_LENGTH
    || imageReference.length > OCI_IMAGE_REFERENCE_MAX_LENGTH
    || !OCI_IMAGE_REFERENCE_PATTERN.test(imageReference)) {
    throw new CliError('config.image.url deve ser uma referencia OCI completa com registro e tag ou digest.');
  }
  if (config.github !== undefined) {
    throw new CliError('Jobs aceitam somente config.image. O fluxo GitHub ainda nao esta disponivel para Jobs.');
  }

  if (!Array.isArray(config.envs)) {
    throw new CliError('config.envs deve ser um array.');
  }
  if (config.envs.length > 100) throw new CliError('config.envs nao pode conter mais de 100 variaveis.');
  for (const env of config.envs) {
    if (!isRecord(env) || typeof env.name !== 'string' || typeof env.value !== 'string') {
      throw new CliError('Cada item de config.envs deve conter name e value como texto.');
    }
  }

  if (!isRecord(config.storage)) throw new CliError('Jobs exigem config.storage.');
  if (typeof config.storage.persistent !== 'boolean') {
    throw new CliError('config.storage.persistent deve ser booleano.');
  }
  const capacity = Number(config.storage.capacity);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 250) {
    throw new CliError('config.storage.capacity deve ser um inteiro entre 1 e 250 GiB.');
  }
  if (config.storage.persistent) {
    if (typeof config.storage.dir_path_to_persist !== 'string' || !config.storage.dir_path_to_persist.trim()) {
      throw new CliError('config.storage.dir_path_to_persist e obrigatorio para storage persistente.');
    }
  } else if (config.storage.dir_path_to_persist !== undefined) {
    throw new CliError('config.storage.dir_path_to_persist nao e aceito para storage efemero.');
  }

  return { ...config, type_project: 'job', job: { ...config.job, cron } };
}

function validateJobPlanAndPayment(plan, paymentMode) {
  if (!WIZARD_JOB_PLAN_OPTIONS.includes(plan)) {
    throw new CliError(`Plano invalido para Jobs: "${plan}". Valores aceitos: ${formatAllowedValues(WIZARD_JOB_PLAN_OPTIONS)}.`);
  }
  if (paymentMode !== 'per_minute') {
    throw new CliError('Jobs agendados aceitam somente o modo de pagamento per_minute.');
  }
}

function validateCreateAutoscaling(config, plan, typeProject) {
  if (config?.autoscaling === undefined) return config;
  if (typeProject !== 'http') {
    throw new CliError('config.autoscaling deve ser informado apenas para projetos HTTP.');
  }
  if (plan === 'free') {
    throw new CliError('Auto-scaling nao esta disponivel para projetos HTTP no plano free.');
  }

  const autoscaling = config.autoscaling;
  if (!autoscaling || typeof autoscaling !== 'object' || Array.isArray(autoscaling)) {
    throw new CliError('config.autoscaling deve ser um objeto.');
  }
  if (autoscaling.enabled !== true) {
    throw new CliError('config.autoscaling.enabled deve ser true na criacao do projeto.');
  }
  if (autoscaling.min_instances !== undefined) {
    throw new CliError('Use config.instances como minimo inicial; config.autoscaling.min_instances nao e aceito na criacao.');
  }

  const instances = Number(config.instances);
  if (!Number.isInteger(instances) || instances <= 0) {
    throw new CliError('config.instances deve ser um inteiro positivo ao criar um projeto com auto-scaling.');
  }

  const maxInstances = Number(autoscaling.max_instances);
  if (!Number.isInteger(maxInstances) || maxInstances < instances) {
    throw new CliError('config.autoscaling.max_instances deve ser um inteiro maior ou igual a config.instances.');
  }

  const nextAutoscaling = {
    enabled: true,
    max_instances: maxInstances,
  };
  for (const key of ['target_cpu_utilization_percent', 'target_memory_utilization_percent']) {
    if (autoscaling[key] === undefined) continue;
    const value = Number(autoscaling[key]);
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      throw new CliError(`config.autoscaling.${key} deve ser um inteiro entre 1 e 100.`);
    }
    nextAutoscaling[key] = value;
  }

  return { ...config, autoscaling: nextAutoscaling };
}

function validateValkeyConfig(config, plan, catalog) {
  const valkeyCatalog = requireValkeyCatalog(catalog);
  const profile = normalizeValkeyProfile(config?.profile);
  const profileDefinition = valkeyCatalog.profiles.find((entry) => entry.id === profile);
  if (!profileDefinition) {
    throw new CliError('config.profile invalido. Use key_value, cache ou queue.');
  }

  const planDefinition = valkeyCatalog.plans.find((entry) => entry.id === plan && entry.profile === profile);
  if (!planDefinition) {
    throw new CliError(`Plano ${plan} nao pode ser usado com o perfil ${profile}. Consulte "zenifra plans --type valkey".`);
  }

  if (config.version !== valkeyCatalog.version) {
    throw new CliError(`config.version invalida: use ${valkeyCatalog.version}, conforme o catalogo Valkey.`);
  }

  const forbiddenFields = ['instances', 'envs', 'image', 'github', 'port', 'exposure', 'autoscaling'];
  const forbiddenField = forbiddenFields.find((field) => config[field] !== undefined);
  if (forbiddenField) {
    throw new CliError(`Valkey nao aceita config.${forbiddenField}. A capacidade e definida pelo plano.`);
  }

  if (profileDefinition.persistence) {
    if (!isRecord(config.storage) || config.storage.persistent !== true) {
      throw new CliError('Perfis Valkey persistentes exigem storage.persistent=true.');
    }
    const capacity = Number(config.storage.capacity);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 250) {
      throw new CliError('storage.capacity deve ser um inteiro entre 1 e 250 GiB.');
    }
  } else if (config.storage !== undefined) {
    throw new CliError('O perfil Cache nao aceita storage.');
  }

  return {
    ...config,
    type_project: 'valkey',
    profile,
    version: valkeyCatalog.version,
  };
}

function validateCreateInput({ plan, paymentMode, config, valkeyCatalog }) {
  const nextTypeProject = normalizeTypeProject(config?.type_project);
  const nextPlan = normalizePlan(plan);
  const nextPaymentMode = normalizePaymentMode(paymentMode);

  if (nextTypeProject === 'job') {
    validateJobPlanAndPayment(nextPlan, nextPaymentMode);
    return {
      plan: nextPlan,
      paymentMode: nextPaymentMode,
      config: validateJobConfig({ ...config, type_project: nextTypeProject }),
    };
  }

  if (!nextPlan || (nextTypeProject !== 'valkey' && !ALLOWED_PLAN_VALUES.has(nextPlan))) {
    throw new CliError(`Plano invalido: "${plan}". Valores aceitos: ${formatAllowedValues(ALLOWED_PLAN_VALUES)}. Docs: ${DOCS_CREATE_HTTP_URL}`);
  }
  if (!nextPaymentMode || !ALLOWED_PAYMENT_MODE_VALUES.has(nextPaymentMode) || nextPaymentMode === 'per_minute') {
    throw new CliError(`Modo de pagamento invalido: "${paymentMode}". Valores aceitos: ${formatAllowedValues(new Set(['hourly', 'monthly', 'yearly']))}. Docs: ${DOCS_PAYMENTS_URL}`);
  }

  if (!nextTypeProject || !ALLOWED_TYPE_PROJECT_VALUES.has(nextTypeProject)) {
    throw new CliError(`type_project invalido: "${config?.type_project}". Valores aceitos: ${formatAllowedValues(ALLOWED_TYPE_PROJECT_VALUES)}. Docs: ${DOCS_CREATE_HTTP_URL}`);
  }

  const nextConfig = { ...config, type_project: nextTypeProject };
  if (nextTypeProject === 'valkey') {
    return {
      plan: nextPlan,
      paymentMode: nextPaymentMode,
      config: validateValkeyConfig(nextConfig, nextPlan, valkeyCatalog),
    };
  }

  if (nextTypeProject === 'http' && nextConfig.github) {
    const nextRuntime = normalizeRuntime(nextConfig.github.runtime);
    if (!nextRuntime || !ALLOWED_RUNTIME_VALUES.has(nextRuntime)) {
      throw new CliError(`Runtime invalido: "${nextConfig.github.runtime || ''}". Valores aceitos: ${formatAllowedValues(ALLOWED_RUNTIME_VALUES)}. Docs: ${DOCS_RUNTIME_URL}`);
    }
    nextConfig.github = { ...nextConfig.github, runtime: nextRuntime };
  }

  if (nextTypeProject === 'http') {
    const nextExposure = normalizeExposure(nextConfig.exposure);
    if (!nextExposure || !ALLOWED_EXPOSURE_VALUES.has(nextExposure)) {
      throw new CliError(`exposure invalido: "${nextConfig.exposure || ''}". Valores aceitos: ${formatAllowedValues(ALLOWED_EXPOSURE_VALUES)}. Docs: ${DOCS_CREATE_HTTP_URL}`);
    }
    nextConfig.exposure = nextExposure;
  } else if (nextConfig.exposure !== undefined) {
    throw new CliError('exposure deve ser informado apenas para projetos HTTP.');
  }

  const validatedConfig = validateCreateAutoscaling(nextConfig, nextPlan, nextTypeProject);

  return {
    plan: nextPlan,
    paymentMode: nextPaymentMode,
    config: validatedConfig,
  };
}

function maskWizardSummary(value, key = '') {
  if (Array.isArray(value)) return value.map((item) => maskWizardSummary(item, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      /token|secret|password|access_key/i.test(entryKey) ? '********' : maskWizardSummary(entryValue, entryKey),
    ]));
  }
  if (typeof value === 'string' && /token|secret|password|access_key/i.test(key)) return '********';
  return value;
}

function printWizardSummary(payload) {
  const masked = maskWizardSummary(payload);
  const projectSummary = masked.config.type_project === 'job'
    ? `  projeto: ${masked.name} | plano: ${masked.plan}`
    : `  projeto: ${masked.name} | plano: ${masked.plan} | pagamento: ${masked.payment_mode}`;
  const lines = [
    '',
    tone('Resumo da criacao', 'green'),
    projectSummary,
    `  tipo: ${masked.config.type_project}`,
  ];

  if (masked.description) lines.push(`  descricao: ${masked.description}`);

  if (masked.config.type_project === 'http') {
    lines.push(`  http: exposicao ${masked.config.exposure} | porta ${masked.config.port} | instancias ${masked.config.instances} | storage ${masked.config.storage.capacity}Gi (${masked.config.storage.persistent ? 'persistente' : 'efemero'})`);
    if (masked.config.autoscaling?.enabled) {
      lines.push(`  auto-scaling: ${masked.config.instances}-${masked.config.autoscaling.max_instances} instancias | CPU ${masked.config.autoscaling.target_cpu_utilization_percent}% | memoria ${masked.config.autoscaling.target_memory_utilization_percent}%`);
    }
    if (masked.config.github) {
      lines.push(`  github: ${masked.config.github.repository_owner}/${masked.config.github.repository_name}@${masked.config.github.branch} | runtime ${masked.config.github.runtime}@${masked.config.github.version}`);
    } else if (masked.config.image) {
      lines.push(`  imagem: ${masked.config.image.url} | publica: ${masked.config.image.is_public ? 'sim' : 'nao'}`);
    }
  }

  if (masked.config.type_project === 'postgresql' || masked.config.type_project === 'mariadb') {
    lines.push(`  banco: versao ${masked.config.version} | instancias ${masked.config.instances} | storage ${masked.config.storage.capacity}Gi`);
  }

  if (masked.config.type_project === 'job') {
    lines.push(`  Job: cron ${masked.config.job.cron} UTC | storage ${masked.config.storage.capacity}Gi (${masked.config.storage.persistent ? 'persistente' : 'efemero'})`);
    if (masked.config.image) lines.push(`  imagem: ${masked.config.image.url} | publica: ${masked.config.image.is_public ? 'sim' : 'nao'}`);
    if (masked.config.github) lines.push(`  github: ${masked.config.github.repository_owner}/${masked.config.github.repository_name}@${masked.config.github.branch}`);
  }

  if (masked.config.type_project === 'valkey') {
    lines.push(`  Valkey: perfil ${masked.config.profile} | versao ${masked.config.version}${masked.config.storage ? ` | storage ${masked.config.storage.capacity}Gi persistente` : ' | sem storage persistente'}`);
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

async function buildHttpGithubConfig() {
  const repository_owner = await promptWizardText({
    label: 'Repository owner',
    required: true,
    examples: ['zenifra'],
    docs: DOCS_RUNTIME_URL,
  });

  const repository_name = await promptWizardText({
    label: 'Repository name',
    required: true,
    examples: ['zenifra-cli'],
    docs: DOCS_RUNTIME_URL,
  });

  const branch = await promptWizardText({
    label: 'Branch',
    required: true,
    examples: ['main'],
    docs: DOCS_RUNTIME_URL,
  });

  const runtime = await promptWizardText({
    label: 'Runtime',
    required: true,
    examples: ['nodejs', 'python'],
    docs: DOCS_RUNTIME_URL,
    allowedValues: [...ALLOWED_RUNTIME_VALUES],
    normalize: normalizeRuntime,
    validate: (value) => (ALLOWED_RUNTIME_VALUES.has(value) ? null : 'use nodejs ou python'),
  });

  const version = await promptWizardSelect({
    label: 'Versao do runtime',
    docs: DOCS_RUNTIME_URL,
    examples: GITHUB_RUNTIME_VERSIONS[runtime],
    options: GITHUB_RUNTIME_VERSIONS[runtime].map((value) => ({ value })),
  });

  const auto_deploy = await promptWizardBoolean({
    label: 'Auto deploy',
    docs: DOCS_RUNTIME_URL,
    examples: ['sim', 'nao'],
  });

  const start_command = await promptWizardText({
    label: 'Start command',
    required: true,
    examples: runtime === 'nodejs' ? ['npm start'] : ['python main.py'],
    docs: DOCS_RUNTIME_URL,
  });

  const preBuildCommand = await promptWizardText({
    label: 'Pre build command',
    examples: ['npm run prisma:generate', 'poetry install'],
    docs: DOCS_RUNTIME_URL,
    emptyValue: null,
  });

  const buildCommandRaw = await promptWizardText({
    label: 'Build command',
    examples: ['npm run build', 'none'],
    docs: DOCS_RUNTIME_URL,
    emptyValue: null,
    normalize: (value) => parseOptionalNullableCommand(value),
  });

  return {
    repository_owner,
    repository_name,
    branch,
    runtime,
    version,
    auto_deploy,
    start_command,
    pre_build_command: preBuildCommand,
    build_command: buildCommandRaw,
  };
}

async function buildHttpImageConfig() {
  const isPublic = await promptWizardBoolean({
    label: 'Imagem publica',
    docs: DOCS_CREATE_HTTP_URL,
    examples: ['sim', 'nao'],
  });
  promptWizardBoolean.ui.state.httpImagePublic = isPublic;

  const image = {
    url: await promptWizardText({
      label: 'Image URL',
      required: true,
      examples: ['ghcr.io/zenifra/app:1.0.0', 'registry.example.com/team/api:2026-05-30'],
      docs: DOCS_CREATE_HTTP_URL,
    }),
    is_public: isPublic,
  };

  if (isPublic) return image;

  const authType = await promptWizardSelect({
    label: 'Tipo de autenticacao da imagem',
    docs: DOCS_CREATE_HTTP_URL,
    examples: ['username_password', 'aws'],
    options: [
      { value: 'username_password', description: 'usuario e token do registry' },
      { value: 'aws', description: 'credenciais ECR/registry AWS' },
    ],
  });
  promptWizardSelect.ui.state.httpImageAuthType = authType;

  if (authType === 'username_password') {
    image.authentication = {
      auth_type: 'username_password',
      username: await promptWizardText({
        label: 'Username do registry',
        required: true,
        examples: ['docker-user'],
        docs: DOCS_CREATE_HTTP_URL,
      }),
      token: await promptWizardSecret({
        label: 'Token do registry',
        required: true,
        examples: ['ghp_xxx'],
        docs: DOCS_CREATE_HTTP_URL,
      }),
    };
    return image;
  }

  image.authentication = {
    auth_type: 'aws',
    aws: {
      access_key_id: await promptWizardSecret({
        label: 'AWS access key id',
        required: true,
        examples: ['AKIA...'],
        docs: DOCS_CREATE_HTTP_URL,
      }),
      secret_access_key: await promptWizardSecret({
        label: 'AWS secret access key',
        required: true,
        examples: ['secret'],
        docs: DOCS_CREATE_HTTP_URL,
      }),
      region: await promptWizardText({
        label: 'AWS region',
        required: true,
        examples: ['us-east-1'],
        docs: DOCS_CREATE_HTTP_URL,
      }),
      account_id: await promptWizardText({
        label: 'AWS account id',
        required: true,
        examples: ['123456789012'],
        docs: DOCS_CREATE_HTTP_URL,
      }),
    },
  };
  return image;
}

async function buildHttpConfig({ plan, httpPlans, availableInstances }) {
  const source = await promptWizardSelect({
    label: 'Origem do deploy HTTP',
    docs: DOCS_CREATE_HTTP_URL,
    examples: ['github', 'oci'],
    options: [
      { value: 'github', description: 'build a partir de repositorio GitHub' },
      { value: 'oci', description: 'imagem OCI pronta' },
    ],
  });
  promptWizardSelect.ui.state.httpSource = source;

  const port = await promptWizardNumber({
    label: 'Porta da aplicacao',
    docs: DOCS_CREATE_HTTP_URL,
    examples: ['3000', '8080'],
    min: 1,
    max: 65665,
  });

  const instances = await promptWizardNumber({
    label: 'Quantidade de instancias',
    docs: DOCS_CREATE_HTTP_URL,
    examples: ['1', '2', '3'],
    min: 1,
    max: Math.max(1, Number(availableInstances?.[plan] || 1)),
  });

  let autoscaling;
  if (isAutoscalingEnabledForPlan(httpPlans, plan)) {
    const enabled = await promptWizardBoolean({
      label: 'Ativar auto-scaling',
      docs: DOCS_CONFIGURATION_URL,
      examples: ['sim', 'nao'],
    });
    promptWizardBoolean.ui.state.httpAutoscalingEnabled = enabled;
    if (enabled) {
      autoscaling = {
        enabled: true,
        max_instances: await promptWizardNumber({
          label: 'Maximo de instancias do auto-scaling',
          docs: DOCS_CONFIGURATION_URL,
          examples: [String(Math.max(instances, 2))],
          min: instances,
          max: Math.max(instances, Number(availableInstances?.[plan] || instances)),
        }),
        target_cpu_utilization_percent: await promptWizardNumber({
          label: 'CPU alvo do auto-scaling (%)',
          docs: DOCS_CONFIGURATION_URL,
          examples: ['70'],
          min: 1,
          max: 100,
        }),
        target_memory_utilization_percent: await promptWizardNumber({
          label: 'Memoria alvo do auto-scaling (%)',
          docs: DOCS_CONFIGURATION_URL,
          examples: ['80'],
          min: 1,
          max: 100,
        }),
      };
    }
  }

  let storage;
  if (plan === 'free') {
    storage = { persistent: false, capacity: 1 };
    promptWizardBoolean.ui.state.httpStoragePersistent = false;
  } else {
    const persistent = await promptWizardBoolean({
      label: 'Storage persistente',
      docs: DOCS_CONFIGURATION_URL,
      examples: ['sim', 'nao'],
    });
    promptWizardBoolean.ui.state.httpStoragePersistent = persistent;

    storage = {
      persistent,
      ...(persistent ? {
        dir_path_to_persist: await promptWizardText({
          label: 'Diretorio persistente',
          required: true,
          examples: ['/data'],
          docs: DOCS_CONFIGURATION_URL,
        }),
      } : {}),
      capacity: await promptWizardNumber({
        label: 'Capacidade de storage (Gi)',
        docs: DOCS_CONFIGURATION_URL,
        examples: ['1', '5', '10'],
        min: 1,
        max: 250,
      }),
    };
  }

  const envs = await promptWizardPairs({
    introLabel: 'Deseja adicionar variaveis de ambiente?',
    docs: DOCS_CONFIGURATION_URL,
    examples: ['sim', 'nao'],
    stateKey: 'envs',
    itemLabels: [
      { key: 'name', label: 'Nome da env', required: true, examples: ['NODE_ENV'], docs: DOCS_CONFIGURATION_URL },
      { key: 'value', label: 'Valor da env', required: true, examples: ['production'], docs: DOCS_CONFIGURATION_URL },
    ],
  });

  const exposure = await promptWizardSelect({
    label: 'Exposicao HTTP',
    docs: DOCS_CREATE_HTTP_URL,
    examples: WIZARD_HTTP_EXPOSURE_OPTIONS,
    options: WIZARD_HTTP_EXPOSURE_OPTIONS.map((value) => ({ value })),
  });
  promptWizardSelect.ui.state.httpExposure = exposure;

  const isPublicExposure = exposure === 'public';
  const allowBlockIp = isIpAccessEnabled(httpPlans, plan);
  const customWhitelist = isPublicExposure && allowBlockIp
    ? await promptWizardPairs({
      introLabel: 'Deseja configurar whitelist personalizada de entrada?',
      docs: DOCS_CONFIGURATION_URL,
      examples: ['sim', 'nao'],
      stateKey: 'whitelist',
      itemLabels: [
        { key: 'cidr', label: 'CIDR liberado', required: true, examples: ['10.0.0.0/24'], docs: DOCS_CONFIGURATION_URL },
        { key: 'description', label: 'Descricao da whitelist', required: true, examples: ['office'], docs: DOCS_CONFIGURATION_URL },
      ],
    })
    : [];

  const ingress_black_list = isPublicExposure && allowBlockIp
    ? await promptWizardPairs({
      introLabel: 'Deseja adicionar blacklist de entrada?',
      docs: DOCS_CONFIGURATION_URL,
      examples: ['sim', 'nao'],
      stateKey: 'blacklist',
      itemLabels: [
        { key: 'cidr', label: 'CIDR bloqueado', required: true, examples: ['192.168.0.0/24'], docs: DOCS_CONFIGURATION_URL },
        { key: 'description', label: 'Descricao da blacklist', required: true, examples: ['bloqueio temporario'], docs: DOCS_CONFIGURATION_URL },
      ],
    })
    : [];

  const subdomain = isPublicExposure && isSubdomainCustomizable(httpPlans, plan)
    ? await promptWizardText({
      label: 'Subdomain personalizado',
      examples: ['minha-api'],
      docs: DOCS_CONFIGURATION_URL,
    })
    : '';

  return {
    type_project: 'http',
    exposure,
    ...(source === 'github' ? { github: await buildHttpGithubConfig() } : { image: await buildHttpImageConfig() }),
    port,
    instances,
    ...(autoscaling ? { autoscaling } : {}),
    storage,
    envs,
    ...(subdomain ? { subdomain } : {}),
    network_access: {
      ingress_white_list: customWhitelist.length ? customWhitelist : DEFAULT_HTTP_NETWORK_ACCESS.ingress_white_list,
      ingress_black_list,
    },
  };
}

async function buildPostgresqlConfig({ plan, databasePlans }) {
  const maxReplicas = Math.max(1, getMaxReplicasFromFeatures(getPlanFeatures(databasePlans, plan)));
  return {
    type_project: 'postgresql',
    version: await promptWizardSelect({
      label: 'Versao do PostgreSQL',
      docs: DOCS_CREATE_POSTGRESQL_URL,
      examples: ALLOWED_POSTGRESQL_VERSIONS,
      options: ALLOWED_POSTGRESQL_VERSIONS.map((value) => ({ value })),
    }),
    instances: await promptWizardSelect({
      label: 'Instancias do PostgreSQL',
      docs: DOCS_CREATE_POSTGRESQL_URL,
      examples: ['1', '2', String(maxReplicas)],
      options: Array.from({ length: maxReplicas }, (_, index) => String(index + 1)).map((value) => ({ value })),
    }).then((value) => Number(value)),
    storage: {
      persistent: true,
      capacity: plan === 'db-free'
        ? 1
        : await promptWizardNumber({
          label: 'Capacidade de storage do banco (Gi)',
          docs: DOCS_DATABASE_CONFIGURATION_URL,
          examples: ['1', '10', '20'],
          min: 1,
          max: 250,
        }),
    },
    envs: [],
    network_access: DEFAULT_HTTP_NETWORK_ACCESS,
  };
}

async function buildMariadbConfig() {
  return {
    type_project: 'mariadb',
    version: await promptWizardSelect({
      label: 'Versao do MariaDB',
      docs: DOCS_CREATE_MARIADB_URL,
      examples: ALLOWED_MARIADB_VERSIONS,
      options: ALLOWED_MARIADB_VERSIONS.map((value) => ({ value })),
    }),
    instances: 3,
    storage: {
      persistent: true,
      capacity: await promptWizardNumber({
        label: 'Capacidade de storage do banco (Gi)',
        docs: DOCS_DATABASE_CONFIGURATION_URL,
        examples: ['1', '10', '20'],
        min: 1,
        max: 250,
      }),
    },
    envs: [],
    network_access: DEFAULT_HTTP_NETWORK_ACCESS,
  };
}

async function buildValkeyConfig({ profile, plan, catalog }) {
  const planDefinition = catalog.plans.find((entry) => entry.id === plan && entry.profile === profile);
  const profileDefinition = catalog.profiles.find((entry) => entry.id === profile);
  if (!planDefinition || !profileDefinition) {
    throw new CliError('O catalogo Valkey nao possui o plano ou perfil selecionado. Tente novamente.');
  }

  let storage;
  if (profileDefinition.persistence) {
    storage = {
      persistent: true,
      capacity: await promptWizardNumber({
        label: `Capacidade de armazenamento persistente (Gi, inclui ${planDefinition.included_storage_gb ?? 0} Gi)`,
        docs: DOCS_CREATE_VALKEY_URL,
        examples: [String(Math.max(1, planDefinition.included_storage_gb ?? 1)), '10', '20'],
        min: 1,
        max: 250,
      }),
    };
  }

  const whitelist = await promptWizardPairs({
    introLabel: 'Deseja configurar acesso de rede para este projeto?',
    docs: DOCS_CREATE_VALKEY_URL,
    examples: ['sim', 'nao'],
    stateKey: 'valkeyNetworkAccess',
    itemLabels: [
      { key: 'cidr', label: 'CIDR permitido', required: true, examples: ['203.0.113.0/24'], docs: DOCS_CREATE_VALKEY_URL },
      { key: 'description', label: 'Descricao do acesso', required: true, examples: ['Aplicacao'], docs: DOCS_CREATE_VALKEY_URL },
    ],
  });

  let blacklist = [];
  if (whitelist.length > 0) {
    blacklist = await promptWizardPairs({
      introLabel: 'Deseja adicionar bloqueios de rede?',
      docs: DOCS_CREATE_VALKEY_URL,
      examples: ['sim', 'nao'],
      itemLabels: [
        { key: 'cidr', label: 'CIDR bloqueado', required: true, examples: ['198.51.100.0/24'], docs: DOCS_CREATE_VALKEY_URL },
        { key: 'description', label: 'Descricao do bloqueio', required: true, examples: ['Bloqueio'], docs: DOCS_CREATE_VALKEY_URL },
      ],
    });
  }

  return {
    type_project: 'valkey',
    profile,
    version: catalog.version,
    ...(storage ? { storage } : {}),
    ...(whitelist.length > 0 ? {
      network_access: {
        ingress_white_list: whitelist,
        ingress_black_list: blacklist,
      },
    } : {}),
  };
}

async function buildJobConfig() {
  const image = {
    url: await promptWizardText({
      label: 'Imagem OCI da tarefa',
      required: true,
      examples: ['ghcr.io/example/report:1.0.0', 'registry.example.com/team/job@sha256:digest'],
      docs: DOCS_CONFIGURATION_URL,
      validate: (value) => {
        const reference = value.trim();
        return reference.length >= OCI_IMAGE_REFERENCE_MIN_LENGTH
          && reference.length <= OCI_IMAGE_REFERENCE_MAX_LENGTH
          && OCI_IMAGE_REFERENCE_PATTERN.test(reference)
          ? null
          : 'use uma referencia OCI com registro e tag ou digest';
      },
    }),
    is_public: true,
  };
  const persistent = await promptWizardBoolean({
    label: 'Armazenamento persistente',
    docs: DOCS_CONFIGURATION_URL,
    examples: ['sim', 'nao'],
  });
  const storage = {
    persistent,
    capacity: await promptWizardNumber({
      label: 'Capacidade de armazenamento (Gi)',
      docs: DOCS_CONFIGURATION_URL,
      examples: ['1', '5', '10'],
      min: 1,
      max: 250,
    }),
    ...(persistent ? {
      dir_path_to_persist: await promptWizardText({
        label: 'Diretorio persistente',
        required: true,
        examples: ['/data'],
        docs: DOCS_CONFIGURATION_URL,
      }),
    } : {}),
  };
  const envs = await promptWizardPairs({
    introLabel: 'Deseja adicionar variaveis de ambiente?',
    docs: DOCS_CONFIGURATION_URL,
    examples: ['sim', 'nao'],
    stateKey: 'jobEnvs',
    itemLabels: [
      { key: 'name', label: 'Nome da env', required: true, examples: ['MODE'], docs: DOCS_CONFIGURATION_URL },
      { key: 'value', label: 'Valor da env', required: true, examples: ['daily'], docs: DOCS_CONFIGURATION_URL },
    ],
  });
  const cron = await promptWizardText({
    label: 'Cron em UTC (cinco campos)',
    required: true,
    examples: ['0 * * * *'],
    docs: DOCS_CONFIGURATION_URL,
    validate: (value) => value.split(/\s+/).filter(Boolean).length === 5 ? null : 'use exatamente cinco campos em UTC',
  });
  return { type_project: 'job', image, envs, storage, job: { cron } };
}

async function runProjectCreateWizard(session, flags) {
  const catalogs = await fetchWizardCatalogs(session, flags);
  const ui = createWizardUi();
  promptWizardText.ui = ui;
  promptWizardSecret.ui = ui;
  promptWizardBoolean.ui = ui;
  promptWizardSelect.ui = ui;
  promptWizardNumber.ui = ui;

  process.stdout.write(`${tone('Wizard interativo de criacao de projeto Zenifra', 'green')}\n`);
  process.stdout.write(`${toneDim('Digite ? para ajuda detalhada em qualquer campo.')}\n`);

  const name = await promptWizardText({
    label: 'Nome do projeto',
    required: true,
    examples: ['api-web', 'db-app-01'],
    docs: DOCS_CONFIGURATION_URL,
  });
  const description = await promptWizardText({
    label: 'Descricao',
    examples: ['API publica da empresa'],
    docs: DOCS_CONFIGURATION_URL,
  });
  const typeProject = await promptWizardSelect({
    label: 'Tipo do projeto',
    docs: DOCS_CONFIGURATION_URL,
    examples: WIZARD_TYPE_PROJECT_OPTIONS,
    options: WIZARD_TYPE_PROJECT_OPTIONS.map((value) => ({ value })),
    extraValues: ['job'],
  });
  ui.state.typeProject = typeProject;
  const valkeyCatalog = typeProject === 'valkey'
    ? requireValkeyCatalog(unwrapData(await request(session, flags, 'GET', '/managed-services/catalog')))
    : undefined;
  const jobPlans = typeProject === 'job'
    ? requireJobPlans(unwrapData(await request(session, flags, 'GET', '/project/job/plans')))
    : undefined;
  const profile = typeProject === 'valkey'
    ? await promptWizardSelect({
      label: 'Perfil Valkey',
      docs: DOCS_CREATE_VALKEY_URL,
      examples: WIZARD_VALKEY_PROFILE_OPTIONS,
      options: WIZARD_VALKEY_PROFILE_OPTIONS.map((value) => ({ value })),
    })
    : undefined;
  ui.state.valkeyProfile = profile;
  const planOptions = typeProject === 'http'
    ? sortWizardOptions(catalogs.httpPlans
      .map((plan) => plan?.plan)
      .filter((plan) => WIZARD_HTTP_PLAN_OPTIONS.includes(plan) && Number(catalogs.availableInstances?.[plan] || 0) > 0), WIZARD_HTTP_PLAN_OPTIONS)
    : typeProject === 'valkey'
      ? valkeyCatalog.plans
        .filter((planDefinition) => planDefinition.profile === profile)
        .map((planDefinition) => planDefinition.id)
      : typeProject === 'job'
        ? sortWizardOptions(jobPlans.map((plan) => plan?.plan || plan?.id).filter(Boolean), WIZARD_JOB_PLAN_OPTIONS)
    : sortWizardOptions(catalogs.databasePlans
      .map((plan) => plan?.plan)
      .filter((plan) => WIZARD_DATABASE_PLAN_OPTIONS.includes(plan) && (typeProject !== 'mariadb' || plan !== 'db-free')), WIZARD_DATABASE_PLAN_OPTIONS);
  const plan = await promptWizardSelect({
    label: 'Plano',
    docs: typeProject === 'http'
      ? DOCS_CREATE_HTTP_URL
      : typeProject === 'valkey' ? DOCS_CREATE_VALKEY_URL
        : typeProject === 'job' ? DOCS_CONFIGURATION_URL : DOCS_DATABASE_CONFIGURATION_URL,
    examples: [planOptions[0], planOptions.at(-1)],
    options: planOptions.map((value) => ({ value })),
  });
  ui.state.plan = plan;
  if (typeProject === 'http') {
    ui.state.planAllowsBlockIp = isIpAccessEnabled(catalogs.httpPlans, plan);
    ui.state.planAllowsSubdomain = isSubdomainCustomizable(catalogs.httpPlans, plan);
    ui.state.planAllowsAutoscaling = isAutoscalingEnabledForPlan(catalogs.httpPlans, plan);
  }
  const paymentMode = typeProject === 'job' ? 'per_minute' : await promptWizardSelect({
    label: 'Modo de pagamento',
    docs: DOCS_PAYMENTS_URL,
    examples: WIZARD_PAYMENT_MODE_OPTIONS,
    options: WIZARD_PAYMENT_MODE_OPTIONS.map((value) => ({ value })),
  });

  let config;
  if (typeProject === 'http') {
    config = await buildHttpConfig({
      plan,
      httpPlans: catalogs.httpPlans,
      availableInstances: catalogs.availableInstances,
    });
  } else if (typeProject === 'postgresql') {
    config = await buildPostgresqlConfig({ plan, databasePlans: catalogs.databasePlans });
  } else if (typeProject === 'valkey') {
    config = await buildValkeyConfig({ profile, plan, catalog: valkeyCatalog });
  } else if (typeProject === 'job') {
    config = await buildJobConfig();
  } else {
    config = await buildMariadbConfig();
  }

  const payload = {
    name,
    ...(description ? { description } : {}),
    plan,
    payment_mode: paymentMode,
    config,
  };

  printWizardSummary(payload);
  const confirmed = await promptWizardBoolean({
    label: 'Confirmar criacao do projeto',
    docs: typeProject === 'http'
      ? DOCS_CREATE_HTTP_URL
      : typeProject === 'valkey' ? DOCS_CREATE_VALKEY_URL : DOCS_DATABASE_CONFIGURATION_URL,
    examples: ['sim', 'nao'],
  });
  if (!confirmed) return null;
  return payload;
}

async function handleProjectCreate(session, flags) {
  const orgId = await resolveOrgId(session, flags);
  const wizardPayload = hasWizardCreateInput(flags) ? await runProjectCreateWizard(session, flags) : null;

  if (wizardPayload === null && hasWizardCreateInput(flags)) {
    process.stdout.write('Operacao cancelada pelo usuario.\n');
    return;
  }

  const name = wizardPayload?.name || flags.name || await prompt('Nome do projeto');
  const description = wizardPayload?.description || flags.description;
  const plan = wizardPayload?.plan || flags.plan || await prompt('Plano');
  const config = wizardPayload?.config || await parseConfig(flags.config || await prompt('Config JSON ou @arquivo'));
  const typeProject = normalizeTypeProject(config?.type_project);
  const paymentMode = typeProject === 'job'
    ? flags.paymentMode || 'per_minute'
    : wizardPayload?.payment_mode || flags.paymentMode || await prompt('Modo de pagamento');
  const valkeyCatalog = typeProject === 'valkey'
    ? requireValkeyCatalog(unwrapData(await request(session, flags, 'GET', '/managed-services/catalog')))
    : undefined;
  if (flags.idempotencyKey !== undefined && !/^[A-Za-z0-9._-]{16,200}$/.test(String(flags.idempotencyKey))) {
    throw new CliError('--idempotency-key deve ter entre 16 e 200 caracteres: letras, numeros, ponto, underscore ou hifen.');
  }
  const validated = validateCreateInput({ plan, paymentMode, config, valkeyCatalog });

  const payload = await request(session, flags, 'POST', '/project', {
    orgId,
    headers: flags.idempotencyKey === undefined ? {} : { 'Idempotency-Key': String(flags.idempotencyKey) },
    body: {
      name,
      ...(description ? { description: String(description) } : {}),
      plan: validated.plan,
      payment_mode: validated.paymentMode,
      config: validated.config,
    },
  });

  if (flags.json) {
    return printJson(validated.config.type_project === 'job' ? sanitizeJobProjectResponse(payload) : payload);
  }
  if (wizardPayload) {
    closePromptResources();
  }
  const project = unwrapData(payload);
  const rows = [
    { field: 'Projeto', value: projectIdOf(project) || 'id indisponivel' },
    ...(validated.config.type_project === 'job' ? [] : project.domain ? [{ field: 'Dominio', value: formatPublicUrl(project.domain) }] : []),
    ...(project.api_key ? [{ field: 'API key', value: project.api_key }] : []),
  ];
  if (validated.config.type_project === 'valkey') {
    const service = project.managed_service || {};
    rows.push(
      { field: 'Perfil', value: service.profile || validated.config.profile },
      { field: 'Host', value: service.host || '-' },
      { field: 'Porta', value: service.port ?? '-' },
      { field: 'TLS', value: service.tls === true ? 'sim' : 'nao' },
    );
    if (service.connection_string) {
      rows.push({ field: 'String de conexao', value: service.connection_string });
      process.stdout.write('Salve a string de conexao em um local seguro; ela pode nao ser exibida novamente.\n');
    } else {
      rows.push({ field: 'Credencial', value: 'nao retornada nesta resposta; use valkey credentials rotate' });
    }
  }
  process.stdout.write('\n');
  printTable(rows, [
    { label: 'Campo', value: (row) => row.field },
    { label: 'Valor', value: (row) => row.value },
  ]);
}

async function getProject(session, flags, projectId, orgId) {
  return unwrapData(await request(session, flags, 'GET', `/project/${projectId}`, { orgId }));
}

async function handleProjectInfo(session, flags) {
  const projectId = requireProjectId(flags, 'project info');
  if (!projectId) return
  const orgId = await resolveOrgId(session, flags);
  const project = await getProject(session, flags, projectId, orgId);

  if (flags.json) return printJson(isJobProject(project) ? sanitizePublicProject(project) : project);
  printProject({ ...project, id: projectId });
}

async function handleProjectUrl(session, flags) {
  const projectId = requireProjectId(flags, 'project url');
  if (!projectId) return
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
  const projectId = requireProjectId(flags, 'project logs');
  if (!projectId) return
  const orgId = await resolveOrgId(session, flags);
  const query = buildQuery(flags, ['instance']);
  const logs = unwrapData(await request(session, flags, 'GET', `/project/${projectId}/logs${query}`, { orgId }));

  printLogs(logs, flags);
}

const PUBLIC_JOB_RUN_KEYS = [
  'status',
  'scheduled_at',
  'started_at',
  'finished_at',
  'duration_ms',
  'billed_minutes',
  'currency',
  'amount',
  'value',
  'total_amount',
];

function sanitizeJobRun(run) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) return {};
  const output = {};
  const id = run.id || run._id || run.run_id;
  if (id !== undefined) output.id = id;
  for (const key of PUBLIC_JOB_RUN_KEYS) {
    if (run[key] !== undefined) output[key] = run[key];
  }
  return output;
}

function jobRunsDataOf(data) {
  if (Array.isArray(data)) return { runs: data.map(sanitizeJobRun), pagination: null };
  if (!data || typeof data !== 'object') return { runs: [], pagination: null };
  return {
    runs: Array.isArray(data.runs) ? data.runs.map(sanitizeJobRun) : [],
    pagination: data.pagination ?? null,
  };
}

function formatJobRunDuration(durationMs) {
  if (durationMs === undefined || durationMs === null || !Number.isFinite(Number(durationMs))) return '-';
  const seconds = Number(durationMs) / 1000;
  return `${Number(seconds.toFixed(1))} s`;
}

function formatJobRunAmount(run) {
  const amount = run.amount ?? run.value ?? run.total_amount;
  if (amount === undefined || amount === null) return '-';
  return formatMoney(amount, run.currency);
}

function printJobRuns(data) {
  const runs = asArray(data?.runs);
  printTable(runs, [
    { label: 'ID', value: (run) => run.id || '-' },
    { label: 'Status', value: (run) => run.status || '-' },
    { label: 'Agendada', value: (run) => run.scheduled_at || '-' },
    { label: 'Iniciada', value: (run) => run.started_at || '-' },
    { label: 'Finalizada', value: (run) => run.finished_at || '-' },
    { label: 'Duracao', value: (run) => formatJobRunDuration(run.duration_ms) },
    { label: 'Minutos cobrados', value: (run) => run.billed_minutes ?? '-' },
    { label: 'Valor', value: formatJobRunAmount },
  ]);
  printPagination(data?.pagination, 'execucao');
}

function sanitizeJobRunLogEntries(logs) {
  if (!Array.isArray(logs)) return logs;
  return logs.map((entry) => {
    if (typeof entry === 'string') return entry;
    if (!entry || typeof entry !== 'object') return String(entry ?? '');
    return Object.fromEntries(['sequence', 'timestamp', 'level', 'message']
      .filter((key) => entry[key] !== undefined)
      .map((key) => [key, entry[key]]));
  });
}

function sanitizeJobRunLogs(data) {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return sanitizeJobRunLogEntries(data);
  if (!data || typeof data !== 'object') return data;
  const output = {};
  for (const key of ['logs', 'next_cursor', 'truncated', 'finished', 'status']) {
    if (data[key] !== undefined) output[key] = key === 'logs' ? sanitizeJobRunLogEntries(data[key]) : data[key];
  }
  return output;
}

async function handleProjectRuns(session, flags) {
  const projectId = requireProjectId(flags, 'project runs');
  if (!projectId) return;
  validateProjectListFlags(flags, { maxLimit: 50 });
  const orgId = await resolveOrgId(session, flags);
  const query = buildQuery(flags, ['page', 'limit']);
  const data = jobRunsDataOf(unwrapData(await request(session, flags, 'GET', `/project/${projectId}/job-runs${query}`, { orgId })));

  if (flags.json) return printJson(data);
  printJobRuns(data);
}

async function handleProjectRunCancel(session, flags) {
  const projectId = requireProjectId(flags, 'project runs cancel');
  if (!projectId) return;
  if (!flags.run && !flags.runId || flags.run === true || flags.runId === true) {
    printCommandHelpAndFail('project runs cancel');
    return;
  }
  const runId = String(flags.run || flags.runId);
  const orgId = await resolveOrgId(session, flags);
  const data = unwrapData(await request(
    session,
    flags,
    'POST',
    `/project/${projectId}/job-runs/${encodeURIComponent(runId)}/cancel`,
    { orgId, body: {} },
  ));

  if (flags.json) return printJson(data);
  const run = data?.run || data;
  process.stdout.write(`Execucao: ${run?.status || 'cancelled'}\\n`);
}

async function handleProjectRunLogs(session, flags) {
  const projectId = requireProjectId(flags, 'project runs logs');
  if (!projectId) return;
  if (!flags.run && !flags.runId || flags.run === true || flags.runId === true) {
    printCommandHelpAndFail('project runs logs');
    return;
  }
  const runId = String(flags.run || flags.runId);
  const orgId = await resolveOrgId(session, flags);
  const data = sanitizeJobRunLogs(unwrapData(await request(
    session,
    flags,
    'GET',
    `/project/${projectId}/job-runs/${encodeURIComponent(runId)}/logs`,
    { orgId },
  )));

  if (flags.json) return printJson(data);
  const logs = typeof data === 'object' && data !== null && !Array.isArray(data) ? data.logs : data;
  if (Array.isArray(logs)) {
    for (const log of logs) process.stdout.write(`${typeof log === 'string' ? log : buildLogLineOf(log)}\n`);
    return;
  }
  printLogs(logs, { json: false });
}

async function handleProjectMetricsCapabilities(session, flags) {
  const projectId = requireProjectId(flags, 'project metrics capabilities');
  if (!projectId) return;
  const orgId = await resolveOrgId(session, flags);
  const capabilities = unwrapData(await request(session, flags, 'GET', `/project/${projectId}/metrics/capabilities`, { orgId }));

  if (flags.json) return printJson(capabilities);
  printMetricsCapabilities(capabilities);
}

async function handleProjectMetrics(session, flags) {
  const projectId = requireProjectId(flags, 'project metrics');
  if (!projectId) return
  const orgId = await resolveOrgId(session, flags);
  const query = buildQuery(flags, ['instance']);
  const metrics = unwrapData(await request(session, flags, 'GET', `/project/${projectId}/metrics${query}`, { orgId }));

  if (flags.json) return printJson(metrics);
  if (metrics?.type === 'valkey') {
    return printValkeyMetrics(metrics);
  }
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
  const projectId = requireProjectId(flags, 'project network');
  if (!projectId) return
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
  const projectId = requireProjectId(flags, 'project image set');
  if (!projectId) return
  const image = flags.image || await prompt('Imagem');
  if (!image) {
    printCommandHelpAndFail('project image set')
    return
  }

  const orgId = await resolveOrgId(session, flags);
  const payload = await request(session, flags, 'PATCH', `/project/${projectId}/image`, {
    orgId,
    body: { image: String(image) },
  });

  if (flags.json) return printJson(payload);
  process.stdout.write('Imagem atualizada com sucesso.\n');
}

async function handleProjectExposureSet(session, flags) {
  const projectId = requireProjectId(flags, 'project exposure set');
  if (!projectId) return
  const exposure = normalizeExposure(flags.exposure);

  if (!ALLOWED_EXPOSURE_VALUES.has(exposure)) {
    throw new CliError('exposure invalido. Use public ou private.');
  }

  const orgId = await resolveOrgId(session, flags);
  const payload = await request(session, flags, 'PATCH', `/project/${projectId}/exposure`, {
    orgId,
    body: { exposure },
  });

  if (flags.json) return printJson(payload);

  printTable([
    { field: 'Exposicao', value: payload.exposure || exposure },
    { field: 'Dominio', value: payload.domain ? formatPublicUrl(payload.domain) : '-' },
    { field: 'Dominios customizados', value: asArray(payload.custom_domains).join(', ') || '-' },
  ], [
    { label: 'Campo', value: (row) => row.field },
    { label: 'Valor', value: (row) => row.value },
  ]);
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
  const projectId = requireProjectId(flags, 'project envs');
  if (!projectId) return
  const orgId = await resolveOrgId(session, flags);
  const envs = await getProjectEnvs(session, flags, projectId, orgId);

  printEnvs(envs, flags);
}

async function handleProjectEnvMutation(session, flags, action) {
  const helpKeyByAction = {
    add: 'project env add',
    update: 'project env update',
    remove: 'project env remove',
  }
  const helpKey = helpKeyByAction[action]
  const projectId = requireProjectId(flags, helpKey);
  if (!projectId) return
  const name = String(flags.name || '').trim();
  if (!name) {
    printCommandHelpAndFail(helpKey)
    return
  }

  const needsValue = action === 'add' || action === 'update';
  const value = needsValue ? String(flags.value ?? await promptHidden('Valor')) : undefined;
  if (needsValue && !value) {
    printCommandHelpAndFail(helpKey)
    return
  }

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
  const projectId = requireProjectId(flags, 'project instances');
  if (!projectId) return
  const orgId = await resolveOrgId(session, flags);
  const instances = unwrapData(await request(session, flags, 'GET', `/project/${projectId}/instances`, { orgId }));

  if (flags.json) return printJson(instances);
  printTable(asArray(instances), [
    { label: 'Instancia', value: (instance) => instance.instance || instance.name || '-' },
  ]);
}

async function handleProjectInstancesSet(session, flags) {
  const projectId = requireProjectId(flags, 'project instances set');
  if (!projectId) return
  if (flags.count === undefined) {
    printCommandHelpAndFail('project instances set')
    return
  }
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

function parseAutoscalingPositiveInteger(value, flagName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CliError(`Informe ${flagName} <n> com um inteiro positivo.`);
  }
  return parsed;
}

function parseAutoscalingTargetPercent(value, flagName) {
  const parsed = parseAutoscalingPositiveInteger(value, flagName);
  if (parsed > 100) {
    throw new CliError(`Informe ${flagName} entre 1 e 100.`);
  }
  return parsed;
}

function autoscalingFromProject(project) {
  return project?.additional_info?.autoscaling || project?.autoscaling || { enabled: false };
}

function printAutoscaling(autoscaling) {
  printTable([
    {
      status: autoscaling.enabled ? 'ativo' : 'inativo',
      min: autoscaling.min_instances || '-',
      max: autoscaling.max_instances || '-',
      cpu: autoscaling.target_cpu_utilization_percent ? `${autoscaling.target_cpu_utilization_percent}%` : '-',
      memory: autoscaling.target_memory_utilization_percent ? `${autoscaling.target_memory_utilization_percent}%` : '-',
    },
  ], [
    { label: 'Status', value: (item) => item.status },
    { label: 'Minimo', value: (item) => item.min },
    { label: 'Maximo', value: (item) => item.max },
    { label: 'CPU alvo', value: (item) => item.cpu },
    { label: 'Memoria alvo', value: (item) => item.memory },
  ]);
}

async function handleProjectAutoscaling(session, flags) {
  const projectId = requireProjectId(flags, 'project autoscaling');
  if (!projectId) return
  const orgId = await resolveOrgId(session, flags);
  const project = await getProject(session, flags, projectId, orgId);
  const autoscaling = autoscalingFromProject(project);

  if (flags.json) return printJson(autoscaling);
  printAutoscaling(autoscaling);
}

async function handleProjectAutoscalingSet(session, flags) {
  const projectId = requireProjectId(flags, 'project autoscaling set');
  if (!projectId) return
  if (flags.min === undefined || flags.max === undefined) {
    printCommandHelpAndFail('project autoscaling set')
    return
  }

  const minInstances = parseAutoscalingPositiveInteger(flags.min, '--min');
  const maxInstances = parseAutoscalingPositiveInteger(flags.max, '--max');
  if (maxInstances < minInstances) {
    throw new CliError('Informe --max maior ou igual a --min.');
  }

  const body = {
    enabled: true,
    min_instances: minInstances,
    max_instances: maxInstances,
  };

  if (flags.cpu !== undefined) {
    body.target_cpu_utilization_percent = parseAutoscalingTargetPercent(flags.cpu, '--cpu');
  }
  if (flags.memory !== undefined) {
    body.target_memory_utilization_percent = parseAutoscalingTargetPercent(flags.memory, '--memory');
  }

  const orgId = await resolveOrgId(session, flags);
  const payload = await request(session, flags, 'PATCH', `/project/${projectId}/autoscaling`, {
    orgId,
    body,
  });

  if (flags.json) return printJson(payload);
  process.stdout.write(`Auto-scaling atualizado: ${minInstances}-${maxInstances} instancias.\n`);
}

async function handleProjectAutoscalingDisable(session, flags) {
  const projectId = requireProjectId(flags, 'project autoscaling disable');
  if (!projectId) return

  const orgId = await resolveOrgId(session, flags);
  const payload = await request(session, flags, 'PATCH', `/project/${projectId}/autoscaling`, {
    orgId,
    body: { enabled: false },
  });

  if (flags.json) return printJson(payload);
  process.stdout.write('Auto-scaling desativado.\n');
}

function printAutoscalingEvents(data) {
  const directions = { scale_up: 'aumento', scale_down: 'reducao' };
  const reasons = { increased_capacity: 'capacidade aumentada', reduced_capacity: 'capacidade reduzida' };
  const events = asArray(data?.events);
  printTable(events, [
    { label: 'Quando', value: (event) => event.occurred_at || '-' },
    { label: 'Direcao', value: (event) => directions[event.direction] || event.direction || '-' },
    {
      label: 'Instancias',
      value: (event) => `${event.previous_instances ?? '-'} -> ${event.new_instances ?? '-'}`,
    },
    {
      label: 'Limites',
      value: (event) => {
        const cpu = typeof event.current_cpu_utilization_percent === 'number' || typeof event.target_cpu_utilization_percent === 'number'
          ? `CPU ${event.current_cpu_utilization_percent ?? '-'}%/${event.target_cpu_utilization_percent ?? '-'}%`
          : null;
        const memory = typeof event.current_memory_utilization_percent === 'number' || typeof event.target_memory_utilization_percent === 'number'
          ? `MEM ${event.current_memory_utilization_percent ?? '-'}%/${event.target_memory_utilization_percent ?? '-'}%`
          : null;
        return [cpu, memory].filter(Boolean).join(' ');
      },
    },
    { label: 'Motivo', value: (event) => reasons[event.reason] || event.reason || event.trigger_metric || '-' },
  ]);

  printPagination(data?.pagination, 'evento');
}

function isIsoDate(value) {
  const text = String(value);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/);
  if (!match || Number.isNaN(Date.parse(text))) return false;

  const [, year, month, day, hour = '00', minute = '00', second = '00'] = match;
  const calendarDate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return calendarDate.getUTCFullYear() === Number(year)
    && calendarDate.getUTCMonth() === Number(month) - 1
    && calendarDate.getUTCDate() === Number(day)
    && Number(hour) <= 23
    && Number(minute) <= 59
    && Number(second) <= 59;
}

function validateProjectListFlags(flags, { maxLimit }) {
  for (const key of ['from', 'to']) {
    if (flags[key] !== undefined && !isIsoDate(flags[key])) {
      throw new CliError(`Informe --${key} <iso> com uma data ISO valida.`);
    }
  }
  if (flags.from !== undefined && flags.to !== undefined && Date.parse(String(flags.from)) > Date.parse(String(flags.to))) {
    throw new CliError('Informe --from anterior ou igual a --to.');
  }
  for (const key of ['page', 'limit']) {
    if (flags[key] === undefined) continue;
    const value = Number(flags[key]);
    if (!Number.isInteger(value) || value <= 0) {
      throw new CliError(`Informe --${key} <n> com um inteiro positivo.`);
    }
    if (key === 'limit' && value > maxLimit) {
      throw new CliError(`Informe --limit entre 1 e ${maxLimit}.`);
    }
  }
}

function printPagination(pagination, singular = 'item') {
  if (!pagination) return;
  const { page, total_pages: totalPages, total } = pagination;
  process.stdout.write(`Pagina ${page} de ${totalPages || 1} - ${total} ${singular}(s)\n`);
}

function formatMoney(value, currency = 'brl') {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '-';
  try {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: String(currency || 'brl').toUpperCase(),
    }).format(amount);
  } catch {
    return `${String(currency || 'brl').toUpperCase()} ${amount.toFixed(2)}`;
  }
}

function printBillingUsage(data) {
  const hours = asArray(data?.hours);
  printTable(hours, [
    { label: 'Inicio', value: (item) => item.hour_start || '-' },
    { label: 'Fim', value: (item) => item.hour_end || '-' },
    { label: 'Instancia-horas', value: (item) => item.compute_instance_hours ?? '-' },
    { label: 'Armazenamento', value: (item) => item.storage_gb_hours === undefined ? '-' : `${item.storage_gb_hours} GB-h` },
    { label: 'Computacao', value: (item) => formatMoney(item.compute_amount, item.currency) },
    { label: 'Storage', value: (item) => formatMoney(item.storage_amount, item.currency) },
    { label: 'Total', value: (item) => formatMoney(item.total_amount, item.currency) },
    { label: 'Status', value: (item) => item.status || '-' },
  ]);

  if (data?.summary) {
    const summary = data.summary;
    process.stdout.write(`Resumo: computacao ${formatMoney(summary.compute_amount, summary.currency)}, armazenamento ${formatMoney(summary.storage_amount, summary.currency)}, total ${formatMoney(summary.total_amount, summary.currency)}\n`);
  }
  printPagination(data?.pagination, 'hora');
}


async function handleProjectAutoscalingEvents(session, flags) {
  const projectId = requireProjectId(flags, 'project autoscaling events');
  if (!projectId) return

  if (flags.direction !== undefined && !['scale_up', 'scale_down'].includes(String(flags.direction))) {
    throw new CliError('direction invalido. Use scale_up ou scale_down.');
  }

  validateProjectListFlags(flags, { maxLimit: 100 });

  const orgId = await resolveOrgId(session, flags);
  const query = buildQuery(flags, ['direction', 'from', 'to', 'page', 'limit']);
  const data = unwrapData(await request(session, flags, 'GET', `/project/${projectId}/autoscaling/events${query}`, { orgId }));

  if (flags.json) return printJson(data);
  printAutoscalingEvents(data);
}

function publicHealthcheckValue(value) {
  if (value === undefined || value === null || value === '') return '-';
  if (typeof value === 'object') return '-';
  return String(value);
}

function healthcheckForOutput(data) {
  if (data?.healthcheck && typeof data.healthcheck === 'object' && !Array.isArray(data.healthcheck)) {
    return data.healthcheck;
  }
  return data || {};
}

function printHealthcheck(data) {
  const healthcheck = healthcheckForOutput(data);
  const rows = [
    { field: 'Status', value: healthcheck.enabled === true ? 'ativo' : healthcheck.enabled === false ? 'inativo' : 'indisponivel' },
    { field: 'Rota', value: publicHealthcheckValue(healthcheck.path) },
    { field: 'Verificacao', value: publicHealthcheckValue(healthcheck.status || healthcheck.state || (healthcheck.enabled ? 'configurada' : 'desativada')) },
  ];
  if (healthcheck.last_check_at !== undefined) rows.push({ field: 'Ultima verificacao', value: publicHealthcheckValue(healthcheck.last_check_at) });
  if (healthcheck.last_failure_at !== undefined) rows.push({ field: 'Ultima falha', value: publicHealthcheckValue(healthcheck.last_failure_at) });
  printTable(rows, [
    { label: 'Campo', value: (row) => row.field },
    { label: 'Valor', value: (row) => row.value },
  ]);
}

function validateHealthcheckPath(value) {
  const path = String(value || '').trim();
  if (!path.startsWith('/')
    || path.startsWith('//')
    || path.includes('?')
    || path.includes('#')
    || path.includes('\\')
    || /\s/.test(path)) {
    throw new CliError('Informe --path como uma rota absoluta, iniciada por /, sem host, query string ou fragmento.');
  }
  return path;
}

function healthcheckFailuresOf(data) {
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.failures) ? data.failures : [];
}

function printHealthcheckFailures(data) {
  const failures = healthcheckFailuresOf(data);
  printTable(failures, [
    { label: 'Quando', value: (failure) => publicHealthcheckValue(failure.occurred_at || failure.observed_at) },
    { label: 'Status', value: (failure) => publicHealthcheckValue(failure.status_code) },
  ]);

  const pagination = data?.pagination;
  if (pagination && pagination.total_pages === undefined && pagination.pages !== undefined) {
    printPagination({ ...pagination, total_pages: pagination.pages }, 'falha');
    return;
  }
  printPagination(pagination, 'falha');
}

async function handleProjectHealthcheckGet(session, flags) {
  const projectId = requireProjectId(flags, 'project healthcheck get');
  if (!projectId) return;
  const orgId = await resolveOrgId(session, flags);
  const data = unwrapData(await request(session, flags, 'GET', `/project/${projectId}/healthcheck`, { orgId }));
  if (flags.json) return printJson(data);
  printHealthcheck(data);
}

async function handleProjectHealthcheckSet(session, flags) {
  const projectId = requireProjectId(flags, 'project healthcheck set');
  if (!projectId) return;
  if (flags.path === undefined || flags.path === true || flags.path === '') {
    printCommandHelpAndFail('project healthcheck set');
    return;
  }
  const path = validateHealthcheckPath(flags.path);
  const orgId = await resolveOrgId(session, flags);
  const payload = await request(session, flags, 'PATCH', `/project/${projectId}/healthcheck`, {
    orgId,
    body: { healthcheck: { enabled: true, path } },
  });
  const data = unwrapData(payload);
  if (flags.json) return printJson(data);
  process.stdout.write(`Verificacao de saude ativada.\nRota: ${path}\n`);
}

async function handleProjectHealthcheckDisable(session, flags) {
  const projectId = requireProjectId(flags, 'project healthcheck disable');
  if (!projectId) return;
  const orgId = await resolveOrgId(session, flags);
  const payload = await request(session, flags, 'PATCH', `/project/${projectId}/healthcheck`, {
    orgId,
    body: { healthcheck: { enabled: false } },
  });
  const data = unwrapData(payload);
  if (flags.json) return printJson(data);
  process.stdout.write('Verificacao de saude desativada.\n');
}

async function handleProjectHealthcheckFailures(session, flags) {
  const projectId = requireProjectId(flags, 'project healthcheck failures');
  if (!projectId) return;
  validateProjectListFlags(flags, { maxLimit: 100 });
  const orgId = await resolveOrgId(session, flags);
  const query = buildQuery(flags, ['page', 'limit']);
  const data = unwrapData(await request(session, flags, 'GET', `/project/${projectId}/healthcheck/failures${query}`, { orgId }));
  if (flags.json) return printJson(data);
  printHealthcheckFailures(data);
}

async function handleProjectBillingUsage(session, flags) {
  const projectId = requireProjectId(flags, 'project billing usage');
  if (!projectId) return;
  validateProjectListFlags(flags, { maxLimit: 50 });
  const orgId = await resolveOrgId(session, flags);
  const query = buildQuery(flags, ['from', 'to', 'page', 'limit']);
  const data = unwrapData(await request(session, flags, 'GET', `/project/${projectId}/billing/hourly-usage${query}`, { orgId }));

  if (flags.json) return printJson(data);
  printBillingUsage(data);
}

function printValkeyStatus(data) {
  printTable([data], [
    { label: 'Status', value: (service) => service.status || '-' },
    { label: 'Perfil', value: (service) => service.profile || '-' },
    { label: 'Versao', value: (service) => service.version || '-' },
    { label: 'Persistente', value: (service) => service.persistence === true ? 'sim' : 'nao' },
    { label: 'Instancias', value: (service) => service.instances ?? '-' },
  ]);
}

function printValkeyConnection(data) {
  printTable([data], [
    { label: 'Host', value: (service) => service.host || '-' },
    { label: 'Porta', value: (service) => service.port ?? '-' },
    { label: 'Usuario', value: (service) => service.username || '-' },
    { label: 'TLS', value: (service) => service.tls === true ? 'sim' : 'nao' },
    { label: 'Conexao', value: (service) => service.connection_string || '-' },
  ]);
}

function printValkeyRotation(data, { accepted = false } = {}) {
  const rows = [
    { field: accepted ? 'Operacao aceita' : 'Operacao', value: data.operation_id || '-' },
    { field: 'Estado', value: data.state || '-' },
  ];
  if (data.connection_string) {
    rows.push({ field: 'String de conexao', value: data.connection_string });
    process.stdout.write('Salve a nova string de conexao em um local seguro; ela pode nao ser exibida novamente.\n');
  }
  printTable(rows, [
    { label: 'Campo', value: (row) => row.field },
    { label: 'Valor', value: (row) => row.value },
  ]);
}

async function waitForValkeyRotation(session, flags, projectId, operationId, orgId) {
  const intervalMs = parseSecondsOption(flags.interval, '--interval', { defaultValue: 2, min: 0.1 }) * 1000;
  const timeoutMs = parseSecondsOption(flags.timeout, '--timeout', { defaultValue: 900, min: 1 }) * 1000;
  const startedAt = Date.now();
  let lastState = 'accepted';

  while (true) {
    const data = unwrapData(await request(
      session,
      flags,
      'GET',
      `/managed-services/${projectId}/credential-rotations/${operationId}`,
      { orgId },
    ));
    lastState = data?.state || lastState;
    if (lastState === 'completed') return data;
    if (['failed', 'cancelled', 'canceled'].includes(lastState)) {
      throw new CliError(`A renovacao de credencial terminou com estado ${lastState}. Operacao: ${operationId}.`);
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new CliError(`Timeout aguardando a renovacao ${operationId}. Ultimo estado: ${lastState}.`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
}

async function handleValkeyStatus(session, flags) {
  const projectId = requireProjectId(flags, 'valkey status');
  if (!projectId) return;
  const orgId = await resolveOrgId(session, flags);
  const data = unwrapData(await request(session, flags, 'GET', `/managed-services/${projectId}/status`, { orgId }));
  if (flags.json) return printJson(data);
  printValkeyStatus(data);
}

async function handleValkeyConnection(session, flags) {
  const projectId = requireProjectId(flags, 'valkey connection');
  if (!projectId) return;
  const orgId = await resolveOrgId(session, flags);
  const data = unwrapData(await request(session, flags, 'GET', `/managed-services/${projectId}/connection`, { orgId }));
  if (flags.json) return printJson(data);
  printValkeyConnection(data);
}

async function handleValkeyCredentialStatus(session, flags) {
  const projectId = requireProjectId(flags, 'valkey credentials status');
  if (!projectId) return;
  if (!flags.operation) {
    printCommandHelpAndFail('valkey credentials status');
    return;
  }
  const orgId = await resolveOrgId(session, flags);
  const data = unwrapData(await request(
    session,
    flags,
    'GET',
    `/managed-services/${projectId}/credential-rotations/${flags.operation}`,
    { orgId },
  ));
  if (flags.json) return printJson(data);
  printValkeyRotation(data);
}

async function handleValkeyCredentialRotate(session, flags) {
  const projectId = requireProjectId(flags, 'valkey credentials rotate');
  if (!projectId) return;
  const idempotencyKey = String(flags.idempotencyKey || randomUUID());
  if (!/^[A-Za-z0-9._-]{16,200}$/.test(idempotencyKey)) {
    throw new CliError('--idempotency-key deve ter entre 16 e 200 caracteres: letras, numeros, ponto, underscore ou hifen.');
  }
  const orgId = await resolveOrgId(session, flags);
  const acceptedPayload = await request(session, flags, 'PATCH', `/managed-services/${projectId}/credentials`, {
    orgId,
    body: {},
    headers: { 'Idempotency-Key': idempotencyKey },
  });
  const accepted = unwrapData(acceptedPayload);
  if (!accepted?.operation_id) throw new CliError('A API nao retornou o identificador da renovacao de credencial.');

  if (flags.wait) {
    const completed = await waitForValkeyRotation(session, flags, projectId, accepted.operation_id, orgId);
    if (flags.json) return printJson(completed);
    printValkeyRotation(completed);
    return;
  }

  if (flags.json) return printJson(acceptedPayload);
  printValkeyRotation(accepted, { accepted: true });
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
  if (!projectId) {
    printCommandHelpAndFail(flags.__commandKey || 'builds')
    return
  }
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
  if (!projectId) {
    process.stdout.write(commandHelp(['deploy']));
    process.exitCode = 1;
    return;
  }
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

async function getBuildLogs(session, flags, projectId, buildId, orgId, { cursor = 0, limit = 200 } = {}) {
  const query = buildQuery({ cursor, limit }, ['cursor', 'limit'])
  return unwrapData(await request(session, flags, 'GET', `/project/${projectId}/github/builds/${buildId}/logs${query}`, { orgId }))
}

function parseIntegerOption(value, flagName, { defaultValue, min, max }) {
  if (value === undefined) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || (max !== undefined && parsed > max)) {
    const range = max === undefined ? `maior ou igual a ${min}` : `entre ${min} e ${max}`;
    throw new CliError(`Informe ${flagName} com um inteiro ${range}.`);
  }
  return parsed;
}

function parseSecondsOption(value, flagName, { defaultValue, min }) {
  if (value === undefined) return defaultValue;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new CliError(`Informe ${flagName} com um numero maior ou igual a ${min}.`);
  }
  return parsed;
}

function printBuildLogs(logs) {
  for (const log of asArray(logs)) {
    process.stdout.write(`${buildLogLineOf(log)}\n`)
  }
}

function printBuildLogEventsJson(logs) {
  for (const log of asArray(logs)) {
    process.stdout.write(`${JSON.stringify(log)}\n`)
  }
}

async function followBuildLogs(session, flags, projectId, buildId, orgId, {
  initialCursor = 0,
  limit = 200,
  intervalSeconds = 5,
  timeoutSeconds = 900,
} = {}) {
  let cursor = parseIntegerOption(initialCursor, '--cursor', { defaultValue: 0, min: 0 })
  const pollLimit = parseIntegerOption(limit, '--limit', { defaultValue: 200, min: 1, max: 500 })
  const intervalMs = parseSecondsOption(intervalSeconds, '--interval', { defaultValue: 5, min: 0.1 }) * 1000
  const timeoutMs = parseSecondsOption(timeoutSeconds, '--timeout', { defaultValue: 900, min: 1 }) * 1000
  const startedAt = Date.now()

  while (true) {
    const result = await getBuildLogs(session, flags, projectId, buildId, orgId, {
      cursor,
      limit: pollLimit,
    })
    const logs = asArray(result?.logs)

    if (flags.json) {
      printBuildLogEventsJson(logs)
    } else {
      printBuildLogs(logs)
    }

    if (typeof result?.next_cursor === 'number') {
      cursor = result.next_cursor
    } else if (logs.length > 0) {
      cursor = logs[logs.length - 1].sequence || cursor
    }

    if (result?.finished) {
      if (result?.status === 'failed') {
        process.exitCode = 1
      }
      return result
    }

    if (Date.now() - startedAt > timeoutMs) {
      throw new CliError(`Timeout aguardando build ${buildId}. Ultimo status: ${result?.status || 'unknown'}`)
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

async function handleBuildLogs(session, flags) {
  const projectId = flags.project;
  const buildId = flags.build;
  if (!projectId || !buildId) {
    printCommandHelpAndFail('builds logs')
    return
  }

  const orgId = await resolveOrgId(session, flags);
  const cursor = parseIntegerOption(flags.cursor, '--cursor', { defaultValue: 0, min: 0 })
  const limit = parseIntegerOption(flags.limit, '--limit', { defaultValue: 200, min: 1, max: 500 })

  if (flags.follow) {
    return followBuildLogs(session, flags, projectId, buildId, orgId, {
      initialCursor: cursor,
      limit,
      intervalSeconds: parseSecondsOption(flags.interval, '--interval', { defaultValue: 5, min: 0.1 }),
      timeoutSeconds: parseSecondsOption(flags.timeout, '--timeout', { defaultValue: 900, min: 1 }),
    })
  }

  const result = await getBuildLogs(session, flags, projectId, buildId, orgId, { cursor, limit })
  if (flags.json) return printJson(result)
  printBuildLogs(result?.logs)
}

async function handleDeployWatch(session, flags) {
  const projectId = flags.project;
  const buildId = flags.build;
  if (!projectId || !buildId) {
    printCommandHelpAndFail('deploy watch')
    return;
  }

  const orgId = await resolveOrgId(session, flags);
  return followBuildLogs(session, flags, projectId, buildId, orgId, {
    initialCursor: 0,
    limit: 200,
    intervalSeconds: parseSecondsOption(flags.interval, '--interval', { defaultValue: 5, min: 0.1 }),
    timeoutSeconds: parseSecondsOption(flags.timeout, '--timeout', { defaultValue: 900, min: 1 }),
  })
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  validateKnownFlags(flags);
  const [command, subcommand] = positional;
  const session = await readSession();
  try {
    if (isRemovedProjectsCreate(positional)) {
      throw new CliError(removedProjectsCreateMessage());
    }

    if (command === 'help') {
      process.stdout.write(commandHelp(positional.slice(1)));
      return;
    }

    if (!command) {
      process.stdout.write(usage());
      return;
    }

    if (flags.help) {
      process.stdout.write(commandHelp(positional));
      return;
    }

    if (isNamespaceCommand(command) && !subcommand) {
      process.stdout.write(commandHelp([command]));
      return;
    }

    if (command === 'auth' && subcommand === 'login') return await handleLogin(session, flags);
    if (command === 'auth' && subcommand === 'api-key') return handleApiKeyLogin(session, flags);
    if (command === 'auth' && subcommand === 'logout') return handleLogout(session, flags);
    if (command === 'profile' && subcommand === 'list') return handleProfileList(session, flags);
    if (command === 'profile' && subcommand === 'show') return handleProfileShow(session, flags, positional);
    if (command === 'profile' && subcommand === 'add') return handleProfileAdd(session, flags);
    if (command === 'profile' && subcommand === 'edit') return handleProfileEdit(session, flags, positional);
    if (command === 'profile' && subcommand === 'use') return handleProfileUse(session, flags, positional);
    if (command === 'profile' && subcommand === 'remove') return handleProfileRemove(session, flags, positional);
    if (command === 'login') return await handleLogin(session, flags);
    if (command === 'logout') return handleLogout(session, flags);
    if (command === 'plans') return handlePlans(session, flags);
    if (command === 'create' && subcommand === 'project') return handleProjectCreate(session, flags);
    if (command === 'orgs') return handleOrgs(session, flags);
    if (command === 'org' && subcommand === 'set') return handleOrgSet(session, flags);
    if (command === 'projects') return handleProjects(session, flags);
    if (command === 'valkey' && subcommand === 'credentials' && positional.length === 2) {
      process.stdout.write(commandHelp(['valkey', 'credentials']));
      return;
    }
    if (command === 'valkey' && subcommand === 'status') return handleValkeyStatus(session, flags);
    if (command === 'valkey' && subcommand === 'connection') return handleValkeyConnection(session, flags);
    if (command === 'valkey' && subcommand === 'credentials' && positional[2] === 'rotate') return handleValkeyCredentialRotate(session, flags);
    if (command === 'valkey' && subcommand === 'credentials' && positional[2] === 'status') return handleValkeyCredentialStatus(session, flags);
    if (command === 'project' && subcommand === 'healthcheck' && positional.length === 2) {
      process.stdout.write(commandHelp(['project', 'healthcheck']));
      return;
    }
    if (command === 'project' && subcommand === 'healthcheck' && positional[2] === 'get') return handleProjectHealthcheckGet(session, flags);
    if (command === 'project' && subcommand === 'healthcheck' && positional[2] === 'set') return handleProjectHealthcheckSet(session, flags);
    if (command === 'project' && subcommand === 'healthcheck' && positional[2] === 'disable') return handleProjectHealthcheckDisable(session, flags);
    if (command === 'project' && subcommand === 'healthcheck' && positional[2] === 'failures') return handleProjectHealthcheckFailures(session, flags);
    if (command === 'project' && subcommand === 'info') return handleProjectInfo(session, flags);
    if (command === 'project' && subcommand === 'url') return handleProjectUrl(session, flags);
    if (command === 'project' && subcommand === 'runs' && positional[2] === 'cancel') return handleProjectRunCancel(session, flags);
    if (command === 'project' && subcommand === 'runs' && positional[2] === 'logs') return handleProjectRunLogs(session, flags);
    if (command === 'project' && subcommand === 'runs') return handleProjectRuns(session, flags);
    if (command === 'project' && subcommand === 'run' && positional[2] === 'logs') return handleProjectRunLogs(session, flags);
    if (command === 'project' && subcommand === 'logs') return handleProjectLogs(session, flags);
    if (command === 'project' && subcommand === 'metrics' && positional[2] === 'capabilities') return handleProjectMetricsCapabilities(session, flags);
    if (command === 'project' && subcommand === 'metrics') return handleProjectMetrics(session, flags);
    if (command === 'project' && subcommand === 'network') return handleProjectNetwork(session, flags);
    if (command === 'project' && subcommand === 'image' && positional[2] === 'set') return handleProjectImageSet(session, flags);
    if (command === 'project' && subcommand === 'exposure' && positional[2] === 'set') return handleProjectExposureSet(session, flags);
    if (command === 'project' && subcommand === 'envs') return handleProjectEnvs(session, flags);
    if (command === 'project' && subcommand === 'env' && positional[2] === 'add') return handleProjectEnvMutation(session, flags, 'add');
    if (command === 'project' && subcommand === 'env' && positional[2] === 'update') return handleProjectEnvMutation(session, flags, 'update');
    if (command === 'project' && subcommand === 'env' && positional[2] === 'remove') return handleProjectEnvMutation(session, flags, 'remove');
    if (command === 'project' && subcommand === 'autoscaling' && positional[2] === 'set') return handleProjectAutoscalingSet(session, flags);
    if (command === 'project' && subcommand === 'autoscaling' && positional[2] === 'disable') return handleProjectAutoscalingDisable(session, flags);
    if (command === 'project' && subcommand === 'autoscaling' && positional[2] === 'events') return handleProjectAutoscalingEvents(session, flags);
    if (command === 'project' && subcommand === 'autoscaling') return handleProjectAutoscaling(session, flags);
    if (command === 'project' && subcommand === 'billing' && positional[2] === 'usage') return handleProjectBillingUsage(session, flags);
    if (command === 'project' && subcommand === 'instances' && positional[2] === 'set') return handleProjectInstancesSet(session, flags);
    if (command === 'project' && subcommand === 'instances') return handleProjectInstances(session, flags);
    if (command === 'builds' && subcommand === 'logs') return handleBuildLogs(session, flags);
    if (command === 'builds') return handleDeployments(session, { ...flags, __commandKey: 'builds' });
    if (command === 'deployments') return handleDeployments(session, { ...flags, __commandKey: 'deployments' });
    if (command === 'deploy' && subcommand === 'watch') return handleDeployWatch(session, flags);
    if (command === 'deploy') return handleDeploy(session, flags);

    throw new CliError(`Comando desconhecido: ${positional.join(' ')}`);
  } finally {
    closePromptResources();
  }
}

main().catch((error) => {
  if (error instanceof CliError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(error.exitCode);
  }

  process.stderr.write('Nao foi possivel concluir a operacao. Tente novamente mais tarde.\n');
  process.exit(1);
});
