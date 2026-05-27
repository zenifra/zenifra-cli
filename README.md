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
zenifra auth login --code 123456
zenifra auth api-key --key znf_sua_chave
zenifra auth logout
zenifra orgs
zenifra org set
zenifra projects --type http
zenifra projects create --name <name> --plan free --payment-mode hourly --config @examples/http-project.json
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
zenifra deployments --project <project-id>
zenifra deploy --project <project-id> --branch main
zenifra deploy watch --project <project-id> --build <build-id>
```

## Configuracao

- API padrao: `https://api.zenifra.com/v1`
- Override de API: `ZENIFRA_API_URL=https://api-stg.zenifra.com/v1`
- API key global: `ZENIFRA_API_KEY=znf_sua_chave`
- Sessao local: `~/.config/zenifra-cli/session.json`
- Override de sessao: `ZENIFRA_CONFIG_DIR=/path/custom`

Todos os comandos de listagem aceitam `--json`.

Valores de variaveis de ambiente sao mascarados por padrao, inclusive em `--json`.
Use `--show-values` apenas quando precisar inspecionar os valores completos.

## Automacao com API key

Crie uma API key global no painel da organizacao e use-a em jobs, pipelines e scripts:

```bash
export ZENIFRA_API_KEY=znf_sua_chave
zenifra projects --type http
zenifra deploy --project <project-id> --branch main
```

Tambem e possivel salvar a chave localmente:

```bash
zenifra auth api-key --key znf_sua_chave
```

API keys globais ja sao vinculadas a uma organizacao, entao comandos como `projects`, `deploy`, `builds` e `deployments` nao precisam de `org set`. Comandos pessoais como `orgs` e `org set` continuam exigindo `zenifra auth login`.

Para reduzir impacto de vazamento, configure IPs permitidos na criacao da API key sempre que a automacao tiver origem fixa.

## Exemplo de projeto HTTP

Use `examples/http-project.json` como base para `zenifra projects create`.

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
