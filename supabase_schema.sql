-- ============================================================
-- Painel PCM / Manutenção Fabril — schema Supabase (v2, chave-valor)
-- Cole este arquivo inteiro no Supabase: SQL Editor > New query > Run
--
-- Substitui a versão anterior (relacional, 9 tabelas). Os 5 painéis do
-- painel já tratam seus dados como blobs opacos no cliente (só JS lê/filtra,
-- nada precisa de SQL relacional/joins hoje) — uma tabela chave-valor
-- espelhando as mesmas chaves já usadas no localStorage do navegador
-- minimiza código novo e risco de mapeamento errado.
-- ============================================================

create table if not exists app_state (
  key text primary key check (key in (
    'painelOrcadoRealizado_data_v1',
    'painelDisponibilidade_data_v1',
    'painelAnaliseFalhas_v1',
    'painelProgramacao_data_v1',
    'painelPlanoAcaoManual_v1'
  )),
  data jsonb not null,
  file_name text,
  updated_by uuid references auth.users default auth.uid(),
  updated_at timestamptz not null default now()
);

alter table app_state enable row level security;

-- ATENÇÃO: qualquer usuário autenticado neste projeto Supabase tem acesso
-- total (leitura e escrita) a todas as 5 linhas — não há coluna de
-- dono/tenant separando dados por usuário. Isso é intencional e seguro
-- enquanto existir só 1 usuário cadastrado (Authentication > Users). Se
-- este projeto for reaproveitado para uma segunda pessoa no futuro, essa
-- policy precisa ganhar isolamento por auth.uid() antes disso.
create policy "auth_full_access" on app_state
  for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');
