-- =====================================================================================
-- SCHEMA: SaaS Financeiro para Escritórios de Advocacia
-- Banco: PostgreSQL (Supabase)
-- Autor: Arquitetura de Dados
-- =====================================================================================
-- DECISÃO DE ARQUITETURA GERAL:
-- Este é um schema multi-tenant "shared database, shared schema" (todos os escritórios
-- na mesma base, isolados por tenant_id + RLS). É o padrão recomendado pelo Supabase
-- para SaaS com centenas/milhares de tenants pequenos-médios, pois evita o overhead
-- operacional de um schema por tenant, mantendo isolamento robusto via RLS no nível
-- do banco (e não apenas na camada de aplicação).
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- 0. EXTENSÕES
-- -------------------------------------------------------------------------------------
create extension if not exists "uuid-ossp";

-- -------------------------------------------------------------------------------------
-- 1. FUNÇÕES AUXILIARES
-- -------------------------------------------------------------------------------------

-- Função genérica para manter updated_at sempre atualizado
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- DECISÃO CRÍTICA DE SEGURANÇA:
-- As políticas de RLS precisam descobrir o tenant_id do usuário autenticado.
-- Fazer isso com uma subquery direta em cada policy (select tenant_id from user_profiles
-- where id = auth.uid()) É PERIGOSO na própria tabela user_profiles: gera recursão
-- infinita de RLS (a policy de user_profiles chamaria a si mesma).
-- A solução padrão Supabase é isolar essa busca em uma função `security definer`,
-- que roda com privilégios elevados, ignorando RLS internamente, e é chamada
-- pelas policies de todas as tabelas (inclusive user_profiles) sem recursão.
create or replace function public.auth_tenant_id()
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select tenant_id
  from public.user_profiles
  where id = auth.uid()
  limit 1;
$$;

-- Função auxiliar para checar a role do usuário logado (usada em policies mais
-- restritivas, ex: só 'owner'/'financial' podem excluir transações).
create or replace function public.auth_user_role()
returns text
language sql
security definer
stable
set search_path = public
as $$
  select role::text
  from public.user_profiles
  where id = auth.uid()
  limit 1;
$$;

-- -------------------------------------------------------------------------------------
-- 2. ENUMS
-- -------------------------------------------------------------------------------------

create type public.user_role as enum ('owner', 'partner', 'associate', 'financial', 'secretary');

create type public.case_status as enum ('ativo', 'suspenso', 'encerrado', 'arquivado');

-- Tipo de "caixa": operacional é o dinheiro do escritório; transitorio_terceiros é
-- dinheiro de/para o cliente (custas judiciais, valores de acordo, etc.) que apenas
-- "passa" pelo escritório. Essa separação é a base de compliance contábil/ética da
-- advocacia (equivalente a uma "conta de trânsito"/trust account).
create type public.cash_type as enum ('operacional', 'transitorio_terceiros');

create type public.movement_type as enum ('receita', 'despesa');

create type public.transaction_category as enum (
  'honorario_recorrente',
  'honorario_exito',
  'custa_judicial',
  'reembolso',
  'despesa_administrativa',
  'imposto'
);

create type public.transaction_status as enum ('pendente', 'pago', 'atrasado', 'cancelado');

-- Papel do sócio/associado dentro de uma regra de split de honorários.
-- 'caixa_escritorio' representa a fatia que fica com o próprio escritório
-- (não é uma pessoa física, por isso split_rules.user_profile_id pode ser NULL
-- quando split_role = 'caixa_escritorio').
create type public.split_role as enum ('originador', 'executor', 'caixa_escritorio', 'outro_socio');

-- -------------------------------------------------------------------------------------
-- 3. TABELA: tenants
-- -------------------------------------------------------------------------------------
create table public.tenants (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  cnpj text unique,
  plan text not null default 'trial',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.tenants is
  'Escritórios de advocacia contratantes do SaaS. Tabela raiz do isolamento multi-tenant.';

create trigger trg_tenants_updated_at
  before update on public.tenants
  for each row execute function public.set_updated_at();

-- -------------------------------------------------------------------------------------
-- 4. TABELA: user_profiles (1:1 com auth.users)
-- -------------------------------------------------------------------------------------
create table public.user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  full_name text not null,
  email text not null,
  role public.user_role not null default 'associate',
  -- Valor/hora padrão do usuário, usado como default em timesheets (pode ser
  -- sobrescrito por lançamento, já que valores podem variar por caso/contrato).
  default_hourly_rate numeric(12,2),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.user_profiles is
  'Perfil de advogados/sócios/financeiro, espelhando auth.users e carregando tenant_id + role.';
comment on column public.user_profiles.role is
  'owner: acesso total + billing. partner: sócio, vê financeiro completo. associate: vê apenas seus timesheets/casos. financial: acesso financeiro operacional sem ser sócio.';

create trigger trg_user_profiles_updated_at
  before update on public.user_profiles
  for each row execute function public.set_updated_at();

create index idx_user_profiles_tenant on public.user_profiles(tenant_id);

-- -------------------------------------------------------------------------------------
-- 5. TABELA: clients
-- -------------------------------------------------------------------------------------
create table public.clients (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  document text, -- CPF ou CNPJ
  email text,
  phone text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.clients is
  'Clientes finais do escritório (pessoa física ou jurídica).';

create trigger trg_clients_updated_at
  before update on public.clients
  for each row execute function public.set_updated_at();

create index idx_clients_tenant on public.clients(tenant_id);

-- -------------------------------------------------------------------------------------
-- 6. TABELA: cases (processos / centros de custo)
-- -------------------------------------------------------------------------------------
create table public.cases (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete restrict,
  case_number text, -- número do processo (CNJ), pode ser nulo em fase de consulta
  title text not null,
  status public.case_status not null default 'ativo',
  -- Sócio que trouxe o cliente/caso (relevante para split_rules 'originador')
  originating_partner_id uuid references public.user_profiles(id) on delete set null,
  -- Sócio/associado responsável pela execução técnica do caso ('executor')
  responsible_partner_id uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.cases is
  'Processos judiciais ou centros de custo internos, sempre vinculados a um cliente.';

create trigger trg_cases_updated_at
  before update on public.cases
  for each row execute function public.set_updated_at();

create index idx_cases_tenant on public.cases(tenant_id);
create index idx_cases_client on public.cases(client_id);

-- -------------------------------------------------------------------------------------
-- 7. TABELA: transactions (coração do sistema)
-- -------------------------------------------------------------------------------------
create table public.transactions (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,

  cash_type public.cash_type not null,
  movement_type public.movement_type not null,
  category public.transaction_category not null,
  status public.transaction_status not null default 'pendente',

  amount numeric(14,2) not null check (amount > 0),
  tax_withheld_amount numeric(14,2) not null default 0 check (tax_withheld_amount >= 0),

  description text,
  due_date date,
  paid_at timestamptz,

  -- Relacionamentos
  recorded_by uuid not null references public.user_profiles(id) on delete restrict,
  client_id uuid references public.clients(id) on delete restrict,
  case_id uuid references public.cases(id) on delete restrict,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- DECISÃO CRÍTICA DE NEGÓCIO:
  -- Toda movimentação classificada como 'transitorio_terceiros' representa dinheiro
  -- que NÃO pertence ao escritório (custas judiciais, valores de acordo repassados
  -- ao cliente, etc.). Por exigência de compliance/rastreabilidade (equivalente a uma
  -- trust account), esse tipo de lançamento é OBRIGATORIAMENTE vinculado a um
  -- processo/caso específico — nunca pode "flutuar" solto no caixa do escritório,
  -- pois cada centavo de terceiros precisa ser auditável por processo.
  -- Lançamentos 'operacional' (receita/despesa do próprio escritório, ex: aluguel,
  -- honorário recorrente) podem ou não estar ligados a um caso.
  constraint chk_transitorio_requires_case
    check (cash_type <> 'transitorio_terceiros' or case_id is not null)
);

comment on table public.transactions is
  'Lançamentos financeiros. Separa caixa operacional (do escritório) de caixa transitório (de terceiros/clientes).';
comment on constraint chk_transitorio_requires_case on public.transactions is
  'Dinheiro de terceiros (custas, repasses) precisa estar sempre rastreado a um processo específico, por exigência de compliance contábil da advocacia.';

create trigger trg_transactions_updated_at
  before update on public.transactions
  for each row execute function public.set_updated_at();

create index idx_transactions_tenant on public.transactions(tenant_id);
create index idx_transactions_case on public.transactions(case_id);
create index idx_transactions_client on public.transactions(client_id);
create index idx_transactions_status on public.transactions(tenant_id, status);

-- -------------------------------------------------------------------------------------
-- 8. TABELA: timesheets
-- -------------------------------------------------------------------------------------
create table public.timesheets (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_profile_id uuid not null references public.user_profiles(id) on delete cascade,
  case_id uuid not null references public.cases(id) on delete cascade,

  work_date date not null,
  hours numeric(6,2) not null check (hours > 0),
  hourly_rate numeric(12,2) not null check (hourly_rate >= 0),

  -- Coluna gerada: evita divergência entre horas*valor e o total realmente cobrado,
  -- já que esse número alimenta diretamente o cálculo de honorário por timesheet.
  billed_amount numeric(14,2) generated always as (hours * hourly_rate) stored,

  description text,
  is_billable boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.timesheets is
  'Registro de horas trabalhadas por advogado em cada caso, base para faturamento por timesheet.';

create trigger trg_timesheets_updated_at
  before update on public.timesheets
  for each row execute function public.set_updated_at();

create index idx_timesheets_tenant on public.timesheets(tenant_id);
create index idx_timesheets_case on public.timesheets(case_id);
create index idx_timesheets_user on public.timesheets(user_profile_id);

-- -------------------------------------------------------------------------------------
-- 9. TABELA: split_rules
-- -------------------------------------------------------------------------------------
create table public.split_rules (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  case_id uuid not null references public.cases(id) on delete cascade,

  -- Pode ser NULL quando split_role = 'caixa_escritorio' (a fatia não pertence a
  -- uma pessoa física, e sim ao caixa operacional do próprio escritório).
  user_profile_id uuid references public.user_profiles(id) on delete cascade,
  split_role public.split_role not null,

  percentage numeric(5,2) not null check (percentage > 0 and percentage <= 100),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Garante consistência: se a fatia é do escritório, não faz sentido ter um sócio
  -- associado; se é de um sócio, o vínculo com user_profile_id é obrigatório.
  constraint chk_split_role_consistency check (
    (split_role = 'caixa_escritorio' and user_profile_id is null)
    or (split_role <> 'caixa_escritorio' and user_profile_id is not null)
  )
);

comment on table public.split_rules is
  'Regras de divisão de honorários por caso (ex: 30% originador, 50% executor, 20% caixa do escritório).';
comment on column public.split_rules.percentage is
  'A soma das percentuais de um mesmo case_id deveria idealmente fechar em 100%; essa validação de soma é feita na camada de aplicação/trigger de negócio, não como CHECK simples, pois depende de agregação entre linhas.';

create trigger trg_split_rules_updated_at
  before update on public.split_rules
  for each row execute function public.set_updated_at();

create index idx_split_rules_tenant on public.split_rules(tenant_id);
create index idx_split_rules_case on public.split_rules(case_id);

-- =====================================================================================
-- 10. ROW LEVEL SECURITY (RLS)
-- =====================================================================================
-- Padrão aplicado em TODAS as tabelas de negócio:
--   USING (tenant_id = auth_tenant_id())        -> controla leitura/update/delete
--   WITH CHECK (tenant_id = auth_tenant_id())   -> controla o que pode ser inserido/gravado
-- Isso garante que, mesmo que a aplicação tenha um bug e esqueça de filtrar por
-- tenant_id numa query, o Postgres nunca retorna nem grava dados de outro tenant.
-- =====================================================================================

-- ---------------------------------------------------------------------
-- tenants
-- ---------------------------------------------------------------------
alter table public.tenants enable row level security;

-- Usuário só enxerga o próprio tenant (não a lista de todos os escritórios do SaaS).
create policy tenants_select on public.tenants
  for select using (id = public.auth_tenant_id());

-- Só 'owner' pode atualizar dados do próprio escritório (ex: nome, plano).
create policy tenants_update on public.tenants
  for update using (id = public.auth_tenant_id() and public.auth_user_role() = 'owner')
  with check (id = public.auth_tenant_id());

-- Criação de tenant e exclusão de tenant são operações de onboarding/offboarding
-- administrativas, feitas via service_role (bypassa RLS) e não pela app com usuário
-- comum — por isso não há policy de insert/delete para usuários autenticados aqui.

-- ---------------------------------------------------------------------
-- user_profiles
-- ---------------------------------------------------------------------
alter table public.user_profiles enable row level security;

create policy user_profiles_select on public.user_profiles
  for select using (tenant_id = public.auth_tenant_id());

create policy user_profiles_insert on public.user_profiles
  for insert with check (
    tenant_id = public.auth_tenant_id()
    and public.auth_user_role() in ('owner', 'partner')
  );

create policy user_profiles_update on public.user_profiles
  for update using (
    tenant_id = public.auth_tenant_id()
    and (id = auth.uid() or public.auth_user_role() in ('owner', 'partner'))
  )
  with check (tenant_id = public.auth_tenant_id());

create policy user_profiles_delete on public.user_profiles
  for delete using (
    tenant_id = public.auth_tenant_id()
    and public.auth_user_role() = 'owner'
  );

-- ---------------------------------------------------------------------
-- clients
-- ---------------------------------------------------------------------
alter table public.clients enable row level security;

create policy clients_select on public.clients
  for select using (tenant_id = public.auth_tenant_id());

create policy clients_insert on public.clients
  for insert with check (tenant_id = public.auth_tenant_id());

create policy clients_update on public.clients
  for update using (tenant_id = public.auth_tenant_id())
  with check (tenant_id = public.auth_tenant_id());

create policy clients_delete on public.clients
  for delete using (
    tenant_id = public.auth_tenant_id()
    and public.auth_user_role() in ('owner', 'partner')
  );

-- ---------------------------------------------------------------------
-- cases
-- ---------------------------------------------------------------------
alter table public.cases enable row level security;

create policy cases_select on public.cases
  for select using (tenant_id = public.auth_tenant_id());

create policy cases_insert on public.cases
  for insert with check (tenant_id = public.auth_tenant_id());

create policy cases_update on public.cases
  for update using (tenant_id = public.auth_tenant_id())
  with check (tenant_id = public.auth_tenant_id());

create policy cases_delete on public.cases
  for delete using (
    tenant_id = public.auth_tenant_id()
    and public.auth_user_role() in ('owner', 'partner')
  );

-- ---------------------------------------------------------------------
-- transactions
-- ---------------------------------------------------------------------
alter table public.transactions enable row level security;

create policy transactions_select on public.transactions
  for select using (tenant_id = public.auth_tenant_id());

create policy transactions_insert on public.transactions
  for insert with check (tenant_id = public.auth_tenant_id());

create policy transactions_update on public.transactions
  for update using (
    tenant_id = public.auth_tenant_id()
    and public.auth_user_role() in ('owner', 'partner', 'financial')
  )
  with check (tenant_id = public.auth_tenant_id());

-- Exclusão de lançamento financeiro é sensível (auditoria) — restrita a owner/financial.
create policy transactions_delete on public.transactions
  for delete using (
    tenant_id = public.auth_tenant_id()
    and public.auth_user_role() in ('owner', 'financial')
  );

-- ---------------------------------------------------------------------
-- timesheets
-- ---------------------------------------------------------------------
alter table public.timesheets enable row level security;

create policy timesheets_select on public.timesheets
  for select using (tenant_id = public.auth_tenant_id());

-- Qualquer usuário do tenant pode lançar suas próprias horas.
create policy timesheets_insert on public.timesheets
  for insert with check (
    tenant_id = public.auth_tenant_id()
    and (user_profile_id = auth.uid() or public.auth_user_role() in ('owner', 'partner', 'financial'))
  );

create policy timesheets_update on public.timesheets
  for update using (
    tenant_id = public.auth_tenant_id()
    and (user_profile_id = auth.uid() or public.auth_user_role() in ('owner', 'partner', 'financial'))
  )
  with check (tenant_id = public.auth_tenant_id());

create policy timesheets_delete on public.timesheets
  for delete using (
    tenant_id = public.auth_tenant_id()
    and (user_profile_id = auth.uid() or public.auth_user_role() in ('owner', 'partner'))
  );

-- ---------------------------------------------------------------------
-- split_rules
-- ---------------------------------------------------------------------
alter table public.split_rules enable row level security;

create policy split_rules_select on public.split_rules
  for select using (tenant_id = public.auth_tenant_id());

-- Regras de divisão de honorário só podem ser criadas/alteradas por sócios/owner,
-- pois definem diretamente quem recebe o quê.
create policy split_rules_insert on public.split_rules
  for insert with check (
    tenant_id = public.auth_tenant_id()
    and public.auth_user_role() in ('owner', 'partner')
  );

create policy split_rules_update on public.split_rules
  for update using (
    tenant_id = public.auth_tenant_id()
    and public.auth_user_role() in ('owner', 'partner')
  )
  with check (tenant_id = public.auth_tenant_id());

create policy split_rules_delete on public.split_rules
  for delete using (
    tenant_id = public.auth_tenant_id()
    and public.auth_user_role() in ('owner', 'partner')
  );

-- -------------------------------------------------------------------------------------
-- 9. AGENDA & COMPROMISSOS (appointments)
-- -------------------------------------------------------------------------------------
create table if not exists public.appointments (
  id uuid default gen_random_uuid() primary key,
  tenant_id uuid references public.tenants(id) on delete cascade not null,
  title text not null,
  description text,
  start_at timestamp with time zone not null,
  client_id uuid references public.clients(id) on delete set null,
  case_id uuid references public.cases(id) on delete set null,
  assignee_id uuid references public.user_profiles(id) on delete set null,
  assignee_name text, -- Nome para compatibilidade ou fallback
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  created_by uuid references auth.users(id) on delete set null
);

-- RLS: Agenda
alter table public.appointments enable row level security;

create policy appointments_select on public.appointments
  for select using (tenant_id = public.auth_tenant_id());

create policy appointments_insert on public.appointments
  for insert with check (
    tenant_id = public.auth_tenant_id()
    and public.auth_user_role() in ('owner', 'secretary', 'partner')
  );

create policy appointments_update on public.appointments
  for update using (
    tenant_id = public.auth_tenant_id()
    and public.auth_user_role() in ('owner', 'secretary', 'partner')
  )
  with check (tenant_id = public.auth_tenant_id());

create policy appointments_delete on public.appointments
  for delete using (
    tenant_id = public.auth_tenant_id()
    and public.auth_user_role() in ('owner', 'secretary', 'partner')
  );

-- ---------------------------------------------------------------------
-- org_tasks (Tarefas Internas)
-- ---------------------------------------------------------------------
create table if not exists public.org_tasks (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  activity text not null,
  assignee_name text not null,
  deadline date not null,
  done boolean not null default false,
  done_at timestamptz,
  description text, -- Observações/Comentários complementares
  created_by uuid references public.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.org_tasks enable row level security;

create policy org_tasks_select on public.org_tasks
  for select using (tenant_id = public.auth_tenant_id());

create policy org_tasks_insert on public.org_tasks
  for insert with check (
    tenant_id = public.auth_tenant_id()
    and public.auth_user_role() in ('owner', 'partner')
  );

create policy org_tasks_update on public.org_tasks
  for update using (tenant_id = public.auth_tenant_id())
  with check (tenant_id = public.auth_tenant_id());

create policy org_tasks_delete on public.org_tasks
  for delete using (
    tenant_id = public.auth_tenant_id()
    and public.auth_user_role() in ('owner', 'partner')
  );

-- ---------------------------------------------------------------------
-- tenant_settings (Configurações do Escritório / Identidade Visual)
-- ---------------------------------------------------------------------
create table if not exists public.tenant_settings (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  office_name text,
  responsible_lawyer text,
  logo_base64 text,
  primary_color text,
  secondary_color text,
  phone text,
  email text,
  address text,
  bank_name text,
  beneficiary_name text,
  pix_key text,
  pix_qr_base64 text,
  gemini_api_key text,
  onboarding_completed boolean default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.tenant_settings enable row level security;

create policy tenant_settings_select on public.tenant_settings
  for select using (tenant_id = public.auth_tenant_id());

create policy tenant_settings_insert on public.tenant_settings
  for insert with check (tenant_id = public.auth_tenant_id());

create policy tenant_settings_update on public.tenant_settings
  for update using (tenant_id = public.auth_tenant_id())
  with check (tenant_id = public.auth_tenant_id());

-- =====================================================================================
-- FIM DO SCHEMA
-- =====================================================================================
