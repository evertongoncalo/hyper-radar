export const AVISO_LEGAL =
  'Informação para apoio à decisão. Não constitui aconselhamento financeiro.';

export function App() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-neutral-800 px-6 py-4">
        <h1 className="text-2xl font-semibold tracking-tight">HyperRadar</h1>
      </header>
      <main className="flex-1 px-6 py-8" />
      <footer className="border-t border-neutral-800 px-6 py-3 text-sm text-neutral-400">
        <p role="note">{AVISO_LEGAL}</p>
      </footer>
    </div>
  );
}
