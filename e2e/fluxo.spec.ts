import { expect, test, type Page } from '@playwright/test';
import { URL_FALSO, type FaseBaleia, type RegistoFalso } from './configuracao';

const AVISO_LEGAL = 'Informação para apoio à decisão. Não constitui aconselhamento financeiro.';
const ENDERECO = `0x${'1'.repeat(40)}`;
const ALIAS = 'Baleia E2E';

async function programarBaleia(fase: FaseBaleia): Promise<void> {
  const r = await fetch(`${URL_FALSO}/__controlo/estado`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fase }),
  });
  expect(r.status).toBe(200);
}

async function registo(): Promise<RegistoFalso> {
  return (await (await fetch(`${URL_FALSO}/__controlo/registo`)).json()) as RegistoFalso;
}

/** Número formatado em pt-PT ("0,00889", "1 305,00 US$") → número (`\s` apanha os espaços do Intl). */
function lerNumeroPt(texto: string): number {
  const m = /-?[\d\s.]*\d(?:,\d+)?/.exec(texto);
  return m ? Number(m[0].replace(/[\s.]/g, '').replace(',', '.')) : Number.NaN;
}

async function irParaAtivo(page: Page, ticker: string): Promise<void> {
  await page.getByRole('link', { name: 'Painel' }).click();
  await page.getByRole('link', { name: ticker, exact: true }).click();
  await expect(page.getByRole('heading', { level: 2, name: ticker, exact: true })).toBeVisible();
}

test('fluxo de fumo: ativo → carteira → análise → evento → sugestão → análise IA', async ({
  page,
}) => {
  const errosConsola: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errosConsola.push(m.text());
  });
  page.on('pageerror', (e) => errosConsola.push(e.message));
  // Aviso legal fixo no rodapé (há cópias nos painéis de sugestão e IA).
  const avisoFixo = page
    .getByRole('contentinfo')
    .getByRole('note')
    .filter({ hasText: AVISO_LEGAL });

  await programarBaleia('sem-posicao');
  await page.goto('/');
  await expect(avisoFixo).toBeVisible();
  await expect(page.getByText('Tempo real: ', { exact: false })).toBeVisible();

  // 1. Adicionar ativo (o servidor falso confirma que BTC existe nos perps nativos).
  await page.getByLabel(/Ticker/).fill('BTC');
  await page.getByRole('button', { name: 'Adicionar ativo' }).click();
  await expect(page.getByRole('link', { name: 'BTC', exact: true })).toBeVisible();
  expect((await registo()).info.meta).toBeGreaterThanOrEqual(1);

  // 2. Adicionar carteira com alias.
  await irParaAtivo(page, 'BTC');
  await page.getByLabel('Endereço').fill(ENDERECO);
  await page.getByLabel('Alias (opcional)').fill(ALIAS);
  await page.getByRole('button', { name: 'Adicionar carteira' }).click();
  await expect(page.getByText('Carteira adicionada.')).toBeVisible();

  // 3. Definições: capital, alavancagem, risco e intervalo mínimo (15 s).
  await page.getByRole('link', { name: 'Definições' }).click();
  await page.getByLabel('Capital (USD)').fill('1000');
  await page.getByLabel('Alavancagem máxima').fill('10');
  await page.getByLabel('Risco por operação (%)').fill('2');
  await page.getByLabel('Intervalo de recolha (s)').fill('15');
  await page.getByRole('button', { name: 'Guardar definições' }).click();
  await expect(page.getByText('Definições guardadas.')).toBeVisible();

  // 4. Iniciar análise: linha de base sem posição (não gera eventos).
  await irParaAtivo(page, 'BTC');
  await page.getByRole('button', { name: 'Iniciar análise de BTC' }).click();
  await expect(page.getByRole('button', { name: 'Parar análise de BTC' })).toBeVisible();
  await expect.poll(async () => (await registo()).info.clearinghouseState ?? 0).toBeGreaterThan(0);
  const feed = page.getByRole('region', { name: 'Eventos em tempo real' });
  await expect(feed.getByText('Ainda não há eventos para este ativo.')).toBeVisible();

  // 5. A baleia abre uma long com SL/TP; o próximo ciclo (≤ 15 s) gera OPENED, entregue por SSE.
  // Sem permissão de notificações no headless, o alerta é o toast dentro da app.
  expect(await page.evaluate(() => Notification.permission)).not.toBe('granted');
  await programarBaleia('long-aberta');
  await expect(page.getByText('BTC · Abriu posição')).toBeVisible({ timeout: 45_000 });
  await expect(feed.getByText('Abriu posição').first()).toBeVisible();

  // 6. Sugestão proporcional: tamanho > 0, SL/TP presentes e aviso legal.
  await page.getByRole('button', { name: 'Calcular sugestão proporcional' }).click();
  const cartao = page.getByRole('article', { name: ALIAS });
  await expect(cartao).toBeVisible();
  await expect(cartao.getByText('Viável', { exact: true })).toBeVisible();
  await expect(cartao.getByText('Long', { exact: true })).toBeVisible();
  const campo = (nome: string) => cartao.locator('dt', { hasText: nome }).locator('+ dd');
  const tamanho = lerNumeroPt(await campo('Tamanho').innerText());
  expect(tamanho).toBeGreaterThan(0);
  const sl = lerNumeroPt(await campo('Stop loss sugerido').innerText());
  const tp = lerNumeroPt(await campo('Take profit sugerido').innerText());
  const entrada = lerNumeroPt(await campo('Entrada de referência').innerText());
  // Long: SL abaixo e TP acima da entrada de referência.
  expect(sl).toBeLessThan(entrada);
  expect(tp).toBeGreaterThan(entrada);
  await expect(cartao.getByText('Sem SL')).toHaveCount(0);
  await expect(cartao.getByText('Sem TP')).toHaveCount(0);
  await expect(
    cartao.getByRole('note').filter({ hasText: /aconselhamento financeiro/ }),
  ).toBeVisible();

  // 7. Análise IA: só após confirmação; OpenAI falsa chamada exatamente uma vez.
  const seccaoIa = page.getByRole('region', { name: 'Análise IA' });
  expect((await registo()).openai).toBe(0);
  await seccaoIa.getByRole('button', { name: 'Analisar com IA' }).click();
  const dialogo = page.getByRole('alertdialog');
  await expect(dialogo).toBeVisible();
  expect((await registo()).openai).toBe(0);
  await dialogo.getByRole('button', { name: 'Confirmar' }).click();
  await expect(seccaoIa.getByText('Viés: Alta')).toBeVisible({ timeout: 30_000 });
  await expect(
    seccaoIa.getByRole('heading', { name: /Cenário hipotético — não é uma recomendação/ }),
  ).toBeVisible();
  await expect(
    seccaoIa.getByText('Aviso E2E: não constitui aconselhamento financeiro.'),
  ).toBeVisible();
  expect((await registo()).openai).toBe(1);

  // 8. Parar a análise.
  await page.getByRole('button', { name: 'Parar análise de BTC' }).click();
  await expect(page.getByRole('button', { name: 'Iniciar análise de BTC' })).toBeVisible();

  await expect(avisoFixo).toBeVisible();
  const final = await registo();
  expect(final.desconhecidos).toBe(0);
  expect(errosConsola).toEqual([]);
});
