import type {
  AgregadoAtivoDto,
  AgregadosAtivoResposta,
  AtivoResumo,
  CarteiraDto,
  DefinicoesComIaDto,
  DefinicoesDto,
  EventoDto,
  RelatorioIaDto,
  ResumoRelatorioIa,
  SaudeAnaliseDto,
  SseCiclo,
  SseEstadoAtivo,
  UltimoSnapshotDto,
} from '@hyper-radar/shared';
import type { AgregadosAtivo, MudancaEstadoAtivo, ResumoCiclo, SaudeAnalise } from '../analise';
import { relatorioIaSchema } from '@hyper-radar/shared';
import type { AgregadoAtivo } from '../motor';
import type {
  Ativo,
  Carteira,
  Definicoes,
  EventoDetalhado,
  RelatorioIaGravado,
  SnapshotCompleto,
} from '../repositorios';
import { ErroApi } from './erros';

/*
 * Conversão domínio → DTOs da API (`@hyper-radar/shared`): datas em ISO 8601, nomes estáveis.
 * Único sítio onde os dois formatos se cruzam.
 */

const iso = (d: Date) => d.toISOString();

export function paraSaudeDto(s: SaudeAnalise | null): SaudeAnaliseDto | null {
  if (!s) return null;
  return {
    runId: s.runId,
    cicloEmCurso: s.cicloEmCurso,
    ultimoCicloSucesso: s.ultimoCicloSucesso ? iso(s.ultimoCicloSucesso) : null,
    ultimoErro: s.ultimoErro
      ? { mensagem: s.ultimoErro.mensagem, instante: iso(s.ultimoErro.instante) }
      : null,
    carteirasDesatualizadas: s.carteirasDesatualizadas,
  };
}

export function paraAtivoResumo(
  a: Ativo,
  extra: { numeroCarteiras: number; eventosNaoLidos: number; saude: SaudeAnalise | null },
): AtivoResumo {
  return {
    id: a.id,
    ticker: a.ticker,
    dex: a.dex,
    estado: a.estado,
    criadoEm: iso(a.criadoEm),
    numeroCarteiras: extra.numeroCarteiras,
    eventosNaoLidos: extra.eventosNaoLidos,
    saude: paraSaudeDto(extra.saude),
  };
}

export function paraCarteiraDto(c: Carteira): CarteiraDto {
  return {
    id: c.id,
    endereco: c.endereco,
    alias: c.alias,
    entidade: c.entidade,
    criadoEm: iso(c.criadoEm),
  };
}

export function paraUltimoSnapshotDto(s: SnapshotCompleto): UltimoSnapshotDto {
  return {
    instante: iso(s.instante),
    runId: s.runId,
    accountValue: s.accountValue,
    accountValueRepresentativo: s.accountValueRepresentativo,
    modoConta: s.modoConta,
    precoMercado: s.marketPx,
    posicao: s.posicao
      ? {
          lado: s.posicao.lado,
          tamanho: s.posicao.tamanho,
          entryPx: s.posicao.entryPx,
          alavancagem: s.posicao.alavancagem,
          tipoMargem: s.posicao.tipoMargem,
          liquidationPx: s.posicao.liquidationPx,
          unrealizedPnl: s.posicao.unrealizedPnl,
          marginUsed: s.posicao.marginUsed,
          notional: s.posicao.notional,
        }
      : null,
    ordens: s.ordens.map((o) => ({
      tipo: o.tipo,
      triggerPx: o.triggerPx,
      tamanho: o.tamanho,
      reduceOnly: o.reduceOnly,
    })),
  };
}

export function paraEventoDto(e: EventoDetalhado): EventoDto {
  return {
    id: e.id,
    tipo: e.tipo,
    assetId: e.assetId,
    walletId: e.walletId,
    runId: e.runId,
    ticker: e.ticker,
    endereco: e.endereco,
    alias: e.alias,
    payload: e.payload,
    lido: e.lido,
    criadoEm: iso(e.criadoEm),
  };
}

export function paraDefinicoesDto(d: Definicoes): DefinicoesDto {
  return {
    capitalUsd: d.capitalUsd,
    alavancagemMaxima: d.alavancagemMaxima,
    riscoPorOperacaoPct: d.riscoPorOperacaoPct,
    intervaloRecolhaSegundos: d.intervaloRecolhaSegundos,
    limiteDiarioChamadasIa: d.limiteDiarioChamadasIa,
    limiteDiarioTokensIa: d.limiteDiarioTokensIa,
    atualizadoEm: iso(d.atualizadoEm),
  };
}

export function paraDefinicoesComIaDto(d: Definicoes, modeloIa: string): DefinicoesComIaDto {
  return { ...paraDefinicoesDto(d), modeloIa };
}

function paraBaseRelatorioIa(r: RelatorioIaGravado) {
  return {
    id: r.id,
    ativoId: r.assetId,
    modelo: r.modelo,
    hashInput: r.hashInput,
    criadoEm: iso(r.criadoEm),
    tokensEntrada: r.tokensEntrada,
    tokensSaida: r.tokensSaida,
    custoEstimadoUsd: r.custoEstimadoUsd,
  };
}

/** Relatório gravado → DTO (o JSON gravado é revalidado; nunca devia falhar). */
export function paraRelatorioIaDto(r: RelatorioIaGravado): RelatorioIaDto {
  const relatorio = relatorioIaSchema.safeParse(r.resposta);
  if (!relatorio.success) {
    throw new ErroApi(500, 'ERRO_INTERNO', `O relatório IA ${r.id} tem um formato inválido.`);
  }
  return { ...paraBaseRelatorioIa(r), relatorio: relatorio.data };
}

export function paraResumoRelatorioIa(r: RelatorioIaGravado): ResumoRelatorioIa {
  const { relatorio } = paraRelatorioIaDto(r);
  return {
    ...paraBaseRelatorioIa(r),
    resumo: relatorio.resumo,
    vies: relatorio.vies,
    confianca: relatorio.confianca,
  };
}

function paraAgregadoDto(a: AgregadoAtivo): AgregadoAtivoDto {
  return { ...a, instante: a.instante === null ? null : new Date(a.instante).toISOString() };
}

export function paraAgregadosDto(a: AgregadosAtivo): AgregadosAtivoResposta {
  return {
    atual: paraAgregadoDto(a.atual),
    variacao1h: a.variacao1h,
    variacao24h: a.variacao24h,
  };
}

export function paraSseEstado(m: MudancaEstadoAtivo): SseEstadoAtivo {
  return { ...m, instante: iso(m.instante) };
}

export function paraSseCiclo(c: ResumoCiclo): SseCiclo {
  return { ...c, instante: iso(c.instante) };
}
