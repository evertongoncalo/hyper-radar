import { describe, expect, it } from 'vitest';
import { CARTEIRA_A, MINUTO, posicao, protecao, snapshot, T0 } from './__testes__/construtores';
import { criarEstadoInicial, processarSnapshot, type EstadoAgregador } from './agregador';
import { CONFIG_OMISSAO as cfg } from './config';
import { TIPOS_IMEDIATOS, type EventoMotor } from './eventos';
import type { OrdemProtecaoMotor, SnapshotCarteira } from './tipos';

/*
 * Testes de propriedade com gerador pseudo-aleatório de semente fixa (mulberry32), sem
 * dependências. Cada semente gera uma sequência de 10–40 snapshots de uma carteira.
 */

function mulberry32(semente: number) {
  let a = semente >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const SEMENTES = Array.from({ length: 300 }, (_, i) => 1_000 + i);
/** Tamanho mínimo gerado: com preço ≥ 60, o notional nunca fica abaixo do mínimo (1 000 USD). */
const TAMANHO_MIN = 20;

function gerarSequencia(semente: number): SnapshotCarteira[] {
  const r = mulberry32(semente);
  const n = 10 + Math.floor(r() * 31);
  let lado: 'long' | 'short' | null = r() < 0.8 ? (r() < 0.5 ? 'long' : 'short') : null;
  let tamanho = lado ? TAMANHO_MIN + Math.round(r() * 2_000) : 0;
  let preco = 100;
  let t = T0 + Math.floor(r() * 10 * MINUTO);
  let ordens: OrdemProtecaoMotor[] = [];
  let liq: number | null = null;
  const seq: SnapshotCarteira[] = [];
  for (let i = 0; i < n; i++) {
    const x = r();
    if (lado === null) {
      if (x < 0.3) {
        lado = r() < 0.5 ? 'long' : 'short';
        tamanho = TAMANHO_MIN + Math.round(r() * 2_000);
      }
    } else if (x < 0.35) {
      // sem alteração
    } else if (x < 0.6) {
      tamanho = Math.max(TAMANHO_MIN, tamanho * (1 + (r() - 0.5) * 0.06)); // ±3 %
    } else if (x < 0.82) {
      tamanho = Math.max(TAMANHO_MIN, tamanho * (1 + (r() < 0.5 ? -1 : 1) * (0.05 + r() * 0.3)));
    } else if (x < 0.9) {
      lado = null;
      tamanho = 0;
    } else {
      lado = lado === 'long' ? 'short' : 'long';
      tamanho = TAMANHO_MIN + Math.round(r() * 2_000);
    }
    preco = Math.min(200, Math.max(60, preco * (1 + (r() - 0.5) * 0.04)));
    if (r() < 0.15) {
      ordens =
        r() < 0.3
          ? []
          : [
              protecao('SL', Math.round(preco * (0.8 + r() * 0.15) * 100) / 100, { oid: i * 2 }),
              ...(r() < 0.5 ? [protecao('TP', Math.round(preco * 1.3), { oid: i * 2 + 1 })] : []),
            ];
    }
    if (r() < 0.2)
      liq = r() < 0.3 ? null : preco * (lado === 'short' ? 1.02 + r() * 0.1 : 0.88 + r() * 0.1);
    seq.push(
      snapshot(t, lado ? posicao(lado, tamanho, { preco, liquidationPx: liq }) : null, {
        precoMercado: preco,
        ordensProtecao: ordens,
      }),
    );
    t += r() < 0.3 ? 15_000 : MINUTO;
  }
  return seq;
}

function correr(seq: SnapshotCarteira[]) {
  let estado: EstadoAgregador = criarEstadoInicial();
  let anterior: SnapshotCarteira | null = null;
  const passos: {
    estadoAntes: EstadoAgregador;
    anterior: SnapshotCarteira | null;
    atual: SnapshotCarteira;
    eventos: EventoMotor[];
    estadoDepois: EstadoAgregador;
  }[] = [];
  for (const atual of seq) {
    const r = processarSnapshot(estado, anterior, atual, cfg);
    passos.push({
      estadoAntes: estado,
      anterior,
      atual,
      eventos: r.eventos,
      estadoDepois: r.estado,
    });
    estado = r.estado;
    anterior = atual;
  }
  return { passos, eventos: passos.flatMap((p) => p.eventos) };
}

/** Prolonga a sequência com snapshots iguais ao último durante mais do que as janelas. */
function estabilizar(seq: SnapshotCarteira[]): SnapshotCarteira[] {
  const ultimo = seq.at(-1)!;
  const extra = Array.from({ length: 8 }, (_, i) => ({
    ...ultimo,
    instante: ultimo.instante + (i + 1) * MINUTO,
  }));
  return [...seq, ...extra];
}

const sinal = (lado: 'long' | 'short') => (lado === 'long' ? 1 : -1);

describe('propriedades do agregador (300 sequências pseudo-aleatórias)', () => {
  it('(a) a linha de base nunca gera eventos', () => {
    for (const semente of SEMENTES) {
      for (const s of gerarSequencia(semente)) {
        expect(processarSnapshot(criarEstadoInicial(), null, s, cfg).eventos).toEqual([]);
      }
    }
  });

  it('(b) reprocessar o mesmo snapshot é determinístico e nunca repete eventos imediatos', () => {
    for (const semente of SEMENTES) {
      const { passos } = correr(gerarSequencia(semente));
      // Chaves já emitidas até ao passo corrente (inclusive). Uma chave igual a um evento que só
      // sairia mais tarde é desejável: é o mesmo evento, deduplicado pela BD.
      const chaves = new Set<string>();
      for (const p of passos) {
        for (const e of p.eventos) chaves.add(e.chaveDedupe);
        // Mesmas entradas → mesmos eventos e mesmas chaves (a BD deduplica a repetição).
        const outra = processarSnapshot(p.estadoAntes, p.anterior, p.atual, cfg);
        expect(outra.eventos).toEqual(p.eventos);
        // O mesmo snapshot outra vez, com o estado já avançado: nada de imediato, chaves novas.
        const repetido = processarSnapshot(p.estadoDepois, p.atual, p.atual, cfg);
        for (const e of repetido.eventos) {
          expect(TIPOS_IMEDIATOS.has(e.tipo), `semente ${semente}: ${e.tipo}`).toBe(false);
          expect(chaves.has(e.chaveDedupe), `semente ${semente}: ${e.chaveDedupe}`).toBe(false);
        }
      }
    }
  });

  it('(c)+(d) a posição reconstruída pelos eventos não diverge da real além dos limiares', () => {
    for (const semente of SEMENTES) {
      const seq = estabilizar(gerarSequencia(semente));
      const { eventos } = correr(seq);
      // Posição com sinal reconstruída a partir da linha de base e dos eventos emitidos.
      const p0 = seq[0]!.posicao;
      let recon = p0 ? sinal(p0.lado) * p0.tamanho : 0;
      for (const e of eventos) {
        if (e.tipo === 'OPENED' || e.tipo === 'FLIPPED') {
          recon = sinal(e.payload.posicao.lado) * e.payload.posicao.tamanho;
        } else if (e.tipo === 'CLOSED') {
          recon = 0;
        } else if (e.tipo === 'INCREASED' || e.tipo === 'REDUCED') {
          // (d) nunca há variação sem posição de referência, e parte da posição notificada.
          expect(recon, `semente ${semente}`).not.toBe(0);
          expect(Math.sign(recon)).toBe(sinal(e.payload.lado));
          expect(Math.abs(recon)).toBeCloseTo(e.payload.tamanhoAnterior, 9);
          recon += sinal(e.payload.lado) * e.payload.delta;
        }
      }
      const final = seq.at(-1)!;
      const real = final.posicao ? sinal(final.posicao.lado) * final.posicao.tamanho : 0;
      if (real === 0 || recon === 0) {
        expect(recon, `semente ${semente}`).toBe(real);
        continue;
      }
      expect(Math.sign(recon), `semente ${semente}`).toBe(Math.sign(real));
      const residuo = Math.abs(real - recon);
      expect((residuo / Math.abs(recon)) * 100, `semente ${semente}`).toBeLessThan(
        cfg.limiarVariacaoPct,
      );
      expect(residuo * final.precoMercado, `semente ${semente}`).toBeLessThan(
        cfg.limiarVariacaoUsd,
      );
    }
  });

  it('(e) eventos legítimos distintos nunca partilham a chave de deduplicação', () => {
    const colisoes: string[] = [];
    for (const semente of SEMENTES) {
      const { eventos } = correr(estabilizar(gerarSequencia(semente)));
      const vistas = new Set<string>();
      for (const e of eventos) {
        if (vistas.has(e.chaveDedupe)) colisoes.push(`semente ${semente}: ${e.chaveDedupe}`);
        vistas.add(e.chaveDedupe);
      }
    }
    expect(colisoes).toEqual([]);
  });

  it('o gerador cobre todos os tipos de evento', () => {
    const tipos = new Set(
      SEMENTES.flatMap((s) => correr(estabilizar(gerarSequencia(s))).eventos.map((e) => e.tipo)),
    );
    expect([...tipos].sort()).toEqual(
      ['CLOSED', 'FLIPPED', 'INCREASED', 'LIQ_NEAR', 'OPENED', 'REDUCED', 'SLTP_CHANGED'].sort(),
    );
    expect(CARTEIRA_A).toMatch(/^0x/);
  });
});
