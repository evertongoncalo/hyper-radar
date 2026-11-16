# HyperRadar

Aplicação web local, **só de leitura**, que acompanha carteiras de baleias na Hyperliquid por ativo (nativos e HIP-3, ex.: `xyz:NVDA`).
Especificação completa: `../PROJETO-hyoer.md` (fora do repositório). Ler antes de qualquer tarefa.

## Regras obrigatórias

- Idioma de tudo (UI, commits, comentários, respostas): **Português de Portugal**.
- Ser breve. Sem relatórios nem ficheiros `.md` além de `CLAUDE.md` e `README.md`.
- Trabalhar por fases; cada fase só começa com autorização do utilizador.
- Alterar apenas o necessário; edições pontuais, nunca reescrever ficheiros inteiros sem permissão.
- Ações irreversíveis ou externas (criar repositório, `git push`, apagar dados) exigem confirmação explícita.
- **Nunca** pedir, guardar ou usar chaves privadas. **Nunca** executar ordens na Hyperliquid.
- Repositório público: nunca commitar `.env`, chaves, listas de carteiras reais ou dumps da BD.

## Stack

- Monorepo `npm workspaces`: `apps/api`, `apps/web`, `packages/shared`.
- API: Node + TypeScript, Fastify, zod, pino, PostgreSQL + Drizzle ORM (migrações versionadas).
- Web: React + TypeScript + Vite + Tailwind, **apenas dark mode**; TanStack Query; SSE.
- Testes: Vitest, Supertest, Playwright. Qualidade: ESLint, Prettier, `tsc --noEmit`.
- IA: OpenAI com Structured Outputs, apenas por ação manual do utilizador.

## Comandos (raiz)

- `npm run lint` · `npm run typecheck` · `npm test` · `npm run build`
- `docker compose up -d` (Postgres)

## Fluxo de trabalho

- Orquestrador delega nos subagentes de `.claude/agents/`, revê o diff e só aprova com lint + `tsc` + testes verdes.
- Um commit por tarefa aprovada, mensagem convencional em PT-PT (ex.: `feat(api): adicionar cliente Hyperliquid`).
- Um branch por fase (`fase-N-nome`), PR para `main`.
- Toda a tarefa inclui testes. Cobertura mínima de 90 % no motor de análise e nos cálculos.
- Testes nunca contactam a API real da Hyperliquid nem a da OpenAI (fixtures e mocks).
- Datas na UI em `Europe/Lisbon`.
