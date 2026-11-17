# HyperRadar

Aplicação web local, **só de leitura**, que acompanha carteiras de baleias na Hyperliquid por ativo.
Não pede chaves privadas nem executa ordens.

> Informação para apoio à decisão. Não constitui aconselhamento financeiro.

## Requisitos

- Node.js 22 ou superior e npm
- Docker com Docker Compose (para o Postgres)

## Instalação

```sh
npm install
cp .env.example .env    # preencher os valores necessários
docker compose up -d    # Postgres em 127.0.0.1:5432
```

A Análise IA (OpenAI, só por clique manual) é opcional: defina `OPENAI_API_KEY` no `.env` (e, se quiser, `OPENAI_MODEL`; omissão `gpt-6.1-sol`). Sem chave, essa função fica indisponível e o resto funciona.

## Arranque rápido

- **Windows:** duplo clique em `scripts\start.bat` · **Linux/macOS:** `./scripts/start.sh` · **Qualquer SO:** `npm run start:local`
- Verifica o Node e o Docker, cria o `.env` (se faltar), instala dependências, arranca o Postgres, aplica migrações, faz o build (só se o código mudou) e abre `http://127.0.0.1:3000` (porta `PORT` do `.env`). Se já estiver a correr, só abre o browser.
- Parar: `scripts\stop.bat`, `./scripts/stop.sh` ou `npm run stop:local` (encerra o servidor e para o Postgres; os dados são mantidos). Estado: `npm run status:local`.
- Logs em `data/logs/`. `HYPERRADAR_NO_BROWSER=1` impede a abertura do browser.

## Comandos

| Comando                             | Descrição                                      |
| ----------------------------------- | ---------------------------------------------- |
| `npm run dev -w @hyper-radar/api`   | API em modo de desenvolvimento (porta 3000)    |
| `npm run dev -w @hyper-radar/web`   | Interface web (Vite, proxy de `/api`)          |
| `npm run lint` / `npm run format`   | ESLint / Prettier                              |
| `npm run typecheck`                 | Verificação de tipos (`tsc --noEmit`)          |
| `npm test`                          | Testes (Vitest)                                |
| `npm run build`                     | Build de todos os workspaces                   |
| `npm run db:up` / `npm run db:down` | Arranca / para o Postgres (o volume é mantido) |
| `npm run db:migrate`                | Aplica as migrações Drizzle (`DATABASE_URL`)   |
| `npm run db:generate`               | Gera uma migração a partir do schema           |
| `npm run verificar:segredos`        | Procura segredos nos ficheiros versionados     |

Os testes de integração da BD usam `TEST_DATABASE_URL` (omissão: base `hyperradar_test` no Postgres local, criada se faltar) e são ignorados se não houver Postgres acessível.

Licença: [MIT](LICENSE).
