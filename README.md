# Zenifra CLI

CLI oficial da Zenifra para autenticar, selecionar organizacao, listar projetos e disparar deployments.

## Uso local

Instale pelo npm:

```bash
npm install -g @zenifra/cli
zenifra --help
```

Para desenvolvimento local:

```bash
npm link
zenifra --help
zenifra help project logs
```

Ou sem link:

```bash
node bin/zenifra.mjs --help
```

Cada comando tem ajuda especifica com exemplos de uso e retorno:

```bash
zenifra project logs --help
zenifra help project env add
```

## Comandos

```bash
zenifra auth login
zenifra auth login --profile staging --code 123456
zenifra auth api-key --key znf_sua_chave
zenifra auth api-key --profile prod --key znf_sua_chave
zenifra auth logout
zenifra profile list
zenifra profile show
zenifra profile add --name staging --description Homologacao --api-base https://api-stg.zenifra.com/v1 --mode api-key --key znf_sua_chave
zenifra profile use staging
zenifra profile edit staging --description "Homologacao interna"
zenifra profile remove staging
zenifra orgs
zenifra org set
zenifra plans
zenifra plans --type http
zenifra plans --type storage --json
zenifra create project
zenifra create project --name <name> --plan free --payment-mode hourly --config @examples/http-project.json
zenifra create project --name <name> --plan basic --payment-mode hourly --config @examples/http-github-project.json
zenifra create project --name <name> --plan db-basic --payment-mode monthly --config @examples/postgresql-project.json
zenifra create project --name <name> --plan db-basic --payment-mode monthly --config @examples/mariadb-project.json
zenifra projects --type http --page 1 --limit 15
zenifra project info --project <project-id>
zenifra project url --project <project-id>
zenifra project logs --project <project-id> --instance <instance-id>
zenifra project metrics --project <project-id> --instance <instance-id>
zenifra project network --project <project-id> --view summary
zenifra project image set --project <project-id> --image ghcr.io/zenifra/app:tag
zenifra project envs --project <project-id>
zenifra project env add --project <project-id> --name NODE_ENV --value production
zenifra project env update --project <project-id> --name NODE_ENV --value staging
zenifra project env remove --project <project-id> --name NODE_ENV
zenifra project instances --project <project-id>
zenifra project instances set --project <project-id> --count 3
zenifra builds --project <project-id>
zenifra builds logs --project <project-id> --build <build-id>
zenifra builds logs --project <project-id> --build <build-id> --follow
zenifra deployments --project <project-id>
zenifra deploy --project <project-id> --branch main
zenifra deploy watch --project <project-id> --build <build-id>
```

## Builds GitHub

Use `zenifra builds` para listar o historico de builds e `zenifra builds logs` para ler os logs do pipeline GitHub de um build especifico.

```bash
zenifra builds --project <project-id>
zenifra builds logs --project <project-id> --build <build-id>
zenifra builds logs --project <project-id> --build <build-id> --follow
zenifra deploy --project <project-id> --branch main
zenifra deploy watch --project <project-id> --build <build-id>
```

Fluxos:

- `zenifra project logs`: logs da aplicacao em execucao
- `zenifra builds logs`: logs do build GitHub
- `zenifra deploy`: dispara o build/deploy GitHub e retorna o `build_id`
- `zenifra deploy watch`: usa esse `build_id` para acompanhar o build em tempo real e imprimir os logs incrementais ate o fim

Se voce rodar apenas `zenifra deploy`, a CLI mostra a ajuda especifica do comando com uso, flags, exemplos e exemplo de retorno.

## Configuracao

- API padrao: `https://api.zenifra.com/v1`
- Override de API: `ZENIFRA_API_URL=https://api-stg.zenifra.com/v1`
- API key global: `ZENIFRA_API_KEY=znf_sua_chave`
- Store local de perfis: `~/.config/zenifra-cli/profiles.json`
- Override do diretorio local: `ZENIFRA_CONFIG_DIR=/path/custom`

Todos os comandos de listagem aceitam `--json`. `zenifra projects` e paginado por padrao com 15 itens por pagina; use `--page <n>` e `--limit <n>` para navegar.

Para comparar custo antes de criar um projeto, use:

```bash
zenifra plans
zenifra plans --type http
zenifra plans --type database
zenifra plans --type storage --json
```

`zenifra plans` funciona sem autenticacao e mostra os catalogos publicos de HTTP, banco e armazenamento.

Valores de variaveis de ambiente sao mascarados por padrao, inclusive em `--json`.
Use `--show-values` apenas quando precisar inspecionar os valores completos.

## Perfis

A CLI agora trabalha com um perfil ativo. Cada perfil pode ter:

- `name`: identificador tecnico usado nos comandos
- `description`: descricao livre
- `apiBaseUrl`: API da Zenifra para aquele ambiente
- credencial:
  - `api_key` para automacao organizacional
  - `access_token` para login pessoal, com `selectedOrganizationId`

Exemplos:

```bash
zenifra profile add --name prod --description Producao --api-base https://api.zenifra.com/v1 --mode api-key --key znf_sua_chave
zenifra profile add --name staging --description Homologacao --api-base https://api-stg.zenifra.com/v1 --mode login
zenifra profile list
zenifra profile show staging
zenifra profile use prod
```

Regras de precedencia:

- `ZENIFRA_API_KEY` sobrescreve a credencial do perfil ativo apenas para a execucao atual
- `ZENIFRA_API_URL` sobrescreve a API base do perfil ativo apenas para a execucao atual
- `auth login` e `auth api-key` operam no perfil ativo por padrao
- `auth login --profile <name>` e `auth api-key --profile <name>` atualizam ou criam outro perfil e o tornam ativo

Migracao:

- se existir `session.json` legado e ainda nao existir `profiles.json`, a CLI migra automaticamente a sessao antiga para um perfil `default`

## Automacao com API key

Crie uma API key global no painel da organizacao e use-a em jobs, pipelines e scripts:

```bash
export ZENIFRA_API_KEY=znf_sua_chave
zenifra projects --type http --page 1 --limit 15
zenifra deploy --project <project-id> --branch main
```

Tambem e possivel salvar a chave localmente no perfil ativo:

```bash
zenifra auth api-key --key znf_sua_chave
```

API keys globais ja sao vinculadas a uma organizacao, entao comandos como `projects`, `deploy`, `builds`, `builds logs` e `deployments` nao precisam de `org set`. Comandos pessoais como `orgs` e `org set` continuam exigindo `zenifra auth login` em um perfil com token de usuario.

Para reduzir impacto de vazamento, configure IPs permitidos na criacao da API key sempre que a automacao tiver origem fixa.

## Exemplos de projetos

Use os arquivos em `examples/` como base para `zenifra create project`:

- `examples/http-project.json`: projeto HTTP com imagem OCI publica
- `examples/http-github-project.json`: projeto HTTP com build via GitHub
- `examples/postgresql-project.json`: projeto PostgreSQL
- `examples/mariadb-project.json`: projeto MariaDB

Se voce rodar apenas `zenifra create project`, a CLI abre um wizard interativo estilo `npm init` e pergunta todos os campos guiados. Cada pergunta mostra:

- se o campo e obrigatorio ou opcional
- exemplos de valores aceitos
- link da documentacao relacionada

O wizard atual cobre:

- projetos `http` com origem `github` ou `oci`
- projetos `postgresql`
- projetos `mariadb`

`zenifra create project` nao assume valores default para `--plan` e `--payment-mode`.
Configs HTTP nao interativas tambem devem informar `config.exposure`; use `public` para criar rota/dominio publico ou `private` para manter a aplicacao sem exposicao na internet.
Antes de escolher um plano com o usuario, compare os catalogos com `zenifra plans` para evitar suposicoes sobre custo.

Valores aceitos:

- `payment_mode`: `hourly`, `monthly`, `yearly`
- `type_project` no `config`: `http`, `postgresql`, `mariadb`
- `exposure` no `config` HTTP: `public`, `private`
- `plan`: `free`, `static`, `basic`, `premium`, `premium_plus`, `business`, `deep_learning_basic`, `deep_learning_premium`, `db-free`, `db-starter`, `db-basic`, `db-premium`, `db-enterprise`
- `config.github.runtime` (quando houver GitHub em projeto HTTP): `nodejs` ou `python`

Observacoes do wizard:

- conflitos entre documentacao e API sao validados pelo contrato real aceito pela API
- em projetos de banco, o wizard nao pergunta `username`, `password` nem `database name`
- em projetos de banco, a CLI preenche apenas campos tecnicos minimos exigidos pela validacao atual da API

## Publicacao no npm

Este pacote e publicado pelo GitHub Actions usando npm Trusted Publishing. O pacote precisa existir no npm antes de configurar Trusted Publishing.

### Primeiro publish

Como `@zenifra/cli` e um pacote scoped publico, faca o primeiro publish autenticado no npm:

```bash
npm login
npm publish --access public
```

### Releases seguintes

1. Em npmjs.com, configure o pacote `@zenifra/cli` com Trusted Publisher:
   - Organization/user: `zenifra`
   - Repository: `zenifra-cli`
   - Workflow filename: `publish.yml`
   - Environment: `npm`
   - Allowed action: `npm publish`
2. Garanta que o repositorio GitHub esteja publico para gerar provenance automatica.
3. Crie uma release tag semver:

```bash
npm version patch
git push origin main --follow-tags
```

Tags `v*` disparam `.github/workflows/publish.yml`, que roda `npm ci`, `npm run check`, `npm test`, `npm pack --dry-run` e `npm publish --access public`.
