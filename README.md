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

Os testes de integração da BD usam `TEST_DATABASE_URL` (omissão: base `hyperradar_test` no Postgres local, criada se faltar) e são ignorados se não houver Postgres acessível.

Licença: [MIT](LICENSE).
