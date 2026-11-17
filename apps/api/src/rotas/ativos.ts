import {
  criarAtivoPedidoSchema,
  paramsIdSchema,
  separarTicker,
  type AtivoDetalhe,
  type AtivoResumo,
  type PrecoMercadoDto,
} from '@hyper-radar/shared';
import type { FastifyPluginAsync } from 'fastify';
import {
  contarCarteirasPorAtivo,
  contarEventosNaoLidos,
  contarEventosNaoLidosPorAtivo,
  criarAtivo,
  ErroTickerDuplicado,
  listarAtivos,
  listarCarteirasDoAtivo,
  obterAtivoPorId,
  obterAtivoPorTicker,
  ultimosSnapshotsPorCarteira,
  type Ativo,
  type SnapshotCompleto,
} from '../repositorios';
import { analisar, ErroApi, naoEncontrado } from './erros';
import { paraAtivoResumo, paraUltimoSnapshotDto } from './mapeadores';
import type { DependenciasRotas, FonteMercadoHyperliquid } from './tipos';

/** Ativo existente ou `ErroApi` 404. */
export async function obterAtivoOu404(deps: DependenciasRotas, id: number): Promise<Ativo> {
  const ativo = await obterAtivoPorId(deps.db, id);
  if (!ativo) throw naoEncontrado('Ativo', id);
  return ativo;
}

/** Resumo de um ativo (contagens lidas da BD; saúde do serviço). */
export async function resumoDoAtivo(deps: DependenciasRotas, ativo: Ativo): Promise<AtivoResumo> {
  const [carteiras, eventosNaoLidos] = await Promise.all([
    listarCarteirasDoAtivo(deps.db, ativo.id),
    contarEventosNaoLidos(deps.db, ativo.id),
  ]);
  return paraAtivoResumo(ativo, {
    numeroCarteiras: carteiras.length,
    eventosNaoLidos,
    saude: deps.analise.obterSaude(ativo.id),
  });
}

/**
 * Confirma na Hyperliquid que o ticker existe no DEX certo (`perpDexs` só para HIP-3, depois
 * `meta(dex)`); caso contrário, `TICKER_INEXISTENTE` com sugestão se só diferir em maiúsculas.
 */
export async function validarTickerNaHyperliquid(
  cliente: FonteMercadoHyperliquid,
  ticker: string,
): Promise<void> {
  const { dex, coin } = separarTicker(ticker);
  const inexistente = (mensagem: string) => new ErroApi(400, 'TICKER_INEXISTENTE', mensagem);
  const sugestao = (nomes: string[], alvo: string) => {
    const parecido = nomes.find((n) => n.toLowerCase() === alvo.toLowerCase());
    return parecido ? ` Quis dizer "${parecido}"?` : '';
  };

  if (dex !== null) {
    const nomes = (await cliente.perpDexs()).map((d) => d.name);
    if (!nomes.includes(dex)) {
      throw inexistente(`O DEX "${dex}" não existe na Hyperliquid.${sugestao(nomes, dex)}`);
    }
  }
  const meta = await cliente.meta(dex);
  const ativo = meta.ativos.find((a) => a.coin === coin);
  const ondeDex = dex === null ? 'nos perps nativos' : `no DEX "${dex}"`;
  if (!ativo) {
    const nomes = meta.ativos.map((a) => a.coin);
    throw inexistente(
      `O ativo "${coin}" não existe ${ondeDex} da Hyperliquid.${sugestao(nomes, coin)}`,
    );
  }
  if (ativo.isDelisted) {
    throw inexistente(`O ativo "${coin}" foi retirado de negociação ${ondeDex} da Hyperliquid.`);
  }
}

/**
 * Preço de mercado para o detalhe: `allMids` da Hyperliquid com tempo máximo; se falhar ou
 * demorar, o último preço gravado num snapshot.
 */
export async function precoMercado(
  deps: DependenciasRotas,
  ativo: Ativo,
  snapshots: SnapshotCompleto[],
): Promise<PrecoMercadoDto | null> {
  let temporizador: NodeJS.Timeout | undefined;
  try {
    const limite = new Promise<never>((_, rejeitar) => {
      temporizador = setTimeout(
        () => rejeitar(new Error('tempo esgotado')),
        deps.timeoutPrecoMs,
      ).unref();
    });
    const mids = await Promise.race([deps.cliente.allMids(ativo.dex), limite]);
    const valor = mids[ativo.ticker];
    if (valor !== undefined && valor > 0) {
      return {
        valor,
        instante: new Date(deps.relogio.agora()).toISOString(),
        fonte: 'hyperliquid',
      };
    }
  } catch {
    // Sem preço ao vivo: recorre ao último snapshot (abaixo).
  } finally {
    clearTimeout(temporizador);
  }
  const recente = snapshots
    .filter((s) => s.marketPx !== null)
    .sort((a, b) => b.instante.getTime() - a.instante.getTime())[0];
  return recente
    ? { valor: recente.marketPx!, instante: recente.instante.toISOString(), fonte: 'snapshot' }
    : null;
}

/** Ativos: listar, criar (validado na Hyperliquid), detalhe e apagar. */
export function rotasAtivos(deps: DependenciasRotas): FastifyPluginAsync {
  return async (app) => {
    app.get('/ativos', async (): Promise<AtivoResumo[]> => {
      const [ativos, carteiras, naoLidos] = await Promise.all([
        listarAtivos(deps.db),
        contarCarteirasPorAtivo(deps.db),
        contarEventosNaoLidosPorAtivo(deps.db),
      ]);
      return ativos.map((a) =>
        paraAtivoResumo(a, {
          numeroCarteiras: carteiras.get(a.id) ?? 0,
          eventosNaoLidos: naoLidos.get(a.id) ?? 0,
          saude: deps.analise.obterSaude(a.id),
        }),
      );
    });

    app.post('/ativos', async (pedido, resposta): Promise<AtivoResumo> => {
      const { ticker } = analisar(criarAtivoPedidoSchema, pedido.body, 'body');
      // Duplicado primeiro: evita uma chamada à Hyperliquid desnecessária.
      if (await obterAtivoPorTicker(deps.db, ticker)) throw new ErroTickerDuplicado(ticker);
      await validarTickerNaHyperliquid(deps.cliente, ticker);
      const ativo = await criarAtivo(deps.db, ticker);
      resposta.status(201);
      return paraAtivoResumo(ativo, { numeroCarteiras: 0, eventosNaoLidos: 0, saude: null });
    });

    app.get('/ativos/:id', async (pedido): Promise<AtivoDetalhe> => {
      const { id } = analisar(paramsIdSchema, pedido.params, 'params');
      const ativo = await obterAtivoOu404(deps, id);
      const [carteiras, snapshots, eventosNaoLidos] = await Promise.all([
        listarCarteirasDoAtivo(deps.db, id),
        ultimosSnapshotsPorCarteira(deps.db, id),
        contarEventosNaoLidos(deps.db, id),
      ]);
      const saude = deps.analise.obterSaude(id);
      const desatualizadas = new Set(saude?.carteirasDesatualizadas ?? []);
      const porCarteira = new Map(snapshots.map((s) => [s.walletId, s]));
      return {
        ...paraAtivoResumo(ativo, { numeroCarteiras: carteiras.length, eventosNaoLidos, saude }),
        precoMercado: await precoMercado(deps, ativo, snapshots),
        carteiras: carteiras.map((c) => {
          const s = porCarteira.get(c.id);
          return {
            id: c.id,
            endereco: c.endereco,
            alias: c.alias,
            entidade: c.entidade,
            desatualizada: desatualizadas.has(c.id),
            ultimoSnapshot: s ? paraUltimoSnapshotDto(s) : null,
          };
        }),
      };
    });

    app.delete('/ativos/:id', async (pedido, resposta) => {
      const { id } = analisar(paramsIdSchema, pedido.params, 'params');
      await obterAtivoOu404(deps, id);
      // Pára os ciclos e apaga numa só transição serializada (sem corrida com `iniciar`).
      await deps.analise.removerAtivo(id);
      return resposta.status(204).send();
    });
  };
}
