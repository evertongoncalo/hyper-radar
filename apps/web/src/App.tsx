import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { BrowserRouter, Link, Route, Routes } from 'react-router';
import { ErroApi } from './api/cliente';
import { Layout } from './componentes/Layout';
import { ProvedorToasts } from './componentes/Toasts';
import { Ativo } from './ecras/Ativo';
import { Carteiras } from './ecras/Carteiras';
import { Definicoes } from './ecras/Definicoes';
import { Eventos } from './ecras/Eventos';
import { Painel } from './ecras/Painel';
import { useTempoReal } from './hooks/tempoReal';

export { AVISO_LEGAL } from './componentes/Layout';

/** Cliente de queries: sem novas tentativas em erros 4xx (são definitivos). */
export function criarQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        retry: (tentativas, erro) =>
          !(erro instanceof ErroApi && erro.estado !== null && erro.estado < 500) && tentativas < 2,
      },
    },
  });
}

function TempoReal() {
  useTempoReal();
  return null;
}

function NaoEncontrado() {
  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-2xl font-semibold">Página não encontrada</h2>
      <Link to="/" className="text-sky-400 underline">
        Voltar ao painel
      </Link>
    </div>
  );
}

/** Rotas e estrutura (sem o router, para os testes usarem `MemoryRouter`). */
export function Aplicacao() {
  return (
    <ProvedorToasts>
      <TempoReal />
      <Layout>
        <Routes>
          <Route path="/" element={<Painel />} />
          <Route path="/ativos/:id" element={<Ativo />} />
          <Route path="/carteiras" element={<Carteiras />} />
          <Route path="/eventos" element={<Eventos />} />
          <Route path="/definicoes" element={<Definicoes />} />
          <Route path="*" element={<NaoEncontrado />} />
        </Routes>
      </Layout>
    </ProvedorToasts>
  );
}

export function App() {
  const [qc] = useState(criarQueryClient);
  return (
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Aplicacao />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
