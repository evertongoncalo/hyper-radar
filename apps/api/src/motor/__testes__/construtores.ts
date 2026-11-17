import type { OrdemProtecaoMotor, PosicaoMotor, SnapshotCarteira } from '../tipos';

/** Endereços fictícios. */
export const CARTEIRA_A = '0x' + 'a'.repeat(40);
export const CARTEIRA_B = '0x' + 'b'.repeat(40);
export const CARTEIRA_C = '0x' + 'c'.repeat(40);
export const ATIVO = 'BTC';
export const MINUTO = 60_000;
export const T0 = 1_700_000_000_000;

export function posicao(
  lado: PosicaoMotor['lado'],
  tamanho: number,
  extra: Partial<PosicaoMotor> & { preco?: number } = {},
): PosicaoMotor {
  const { preco = 100, ...resto } = extra;
  return {
    lado,
    tamanho,
    entryPx: 100,
    leverage: 5,
    tipoMargem: 'cross',
    liquidationPx: null,
    margem: (tamanho * preco) / 5,
    pnl: 0,
    notional: tamanho * preco,
    ...resto,
  };
}

export function protecao(
  tipo: OrdemProtecaoMotor['tipo'],
  triggerPx: number,
  extra: Partial<OrdemProtecaoMotor> = {},
): OrdemProtecaoMotor {
  return { tipo, triggerPx, tamanho: null, reduceOnly: true, oid: 1, ...extra };
}

export function snapshot(
  instante: number,
  pos: PosicaoMotor | null,
  extra: Partial<SnapshotCarteira> = {},
): SnapshotCarteira {
  return {
    carteira: CARTEIRA_A,
    ativo: ATIVO,
    instante,
    posicao: pos,
    ordensProtecao: [],
    accountValue: 1_000_000,
    accountValueRepresentativo: true,
    modoConta: 'default',
    precoMercado: 100,
    ...extra,
  };
}
