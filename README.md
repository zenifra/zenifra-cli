# Zenifra CLI

CLI oficial da Zenifra para autenticar, selecionar organizacao, listar projetos e disparar deployments.

## Uso local

```bash
npm link
zenifra --help
```

Ou sem link:

```bash
node bin/zenifra.mjs --help
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
