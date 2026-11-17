type ConstrutorAudio = typeof AudioContext;

let contexto: AudioContext | null = null;

function construtor(): ConstrutorAudio | null {
  const w = window as unknown as {
    AudioContext?: ConstrutorAudio;
    webkitAudioContext?: ConstrutorAudio;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/** Bip curto (Web Audio, sem ficheiros). Falha em silêncio se o áudio não estiver disponível. */
export function tocarAlerta(): boolean {
  try {
    const C = construtor();
    if (!C) return false;
    contexto ??= new C();
    const ctx = contexto;
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    const osc = ctx.createOscillator();
    const ganho = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    const t = ctx.currentTime;
    ganho.gain.setValueAtTime(0.0001, t);
    ganho.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
    ganho.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    osc.connect(ganho);
    ganho.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.26);
    return true;
  } catch {
    return false;
  }
}

/** Só para testes. */
export function reiniciarSom(): void {
  contexto = null;
}
