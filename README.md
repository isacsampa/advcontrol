# Fluxo de Caixa Jurídico-Financeiro (SaaS)

Este é o frontend completo (Single Page Application - SPA) para o gerenciamento de fluxo de caixa de escritórios de advocacia, projetado para operar em modelo multi-tenant isolado via RLS (Row Level Security).

## 🚀 Como Executar o Projeto

Como o aplicativo foi construído com HTML, CSS e JavaScript puros (sem a necessidade de build builders complexos), você pode executá-lo de duas formas:

1. **Abrindo diretamente**: Dê um duplo-clique no arquivo `index.html` no seu navegador de preferência.
2. **Servidor Local (Recomendado)**: Use uma extensão como o "Live Server" do VS Code ou execute via terminal:
   ```bash
   npx serve .
   ```
   Ou com Python:
   ```bash
   python -m http.server 8000
   ```

---

## ⚙️ Configuração do Supabase

Para que o aplicativo funcione com dados reais, siga os passos abaixo no seu projeto do Supabase:

### 1. Criar o Esquema de Tabelas e RLS
No painel do Supabase, acesse **SQL Editor**, clique em **New Query**, cole todo o conteúdo do arquivo [schema_juridico_financeiro.sql](schema_juridico_financeiro.sql) e clique em **Run**.

### 2. Criar a Trigger de Signup Automático (CRÍTICO)
Como o banco de dados exige que todo perfil de usuário (`user_profiles`) esteja atrelado a um escritório contratante (`tenants`), novos cadastros via Supabase Auth precisam gerar esses registros iniciais automaticamente.

No **SQL Editor**, crie outra query com o código abaixo e execute-a:

```sql
-- Função para criar automaticamente um Tenant (Escritório) e um User Profile quando um usuário se cadastrar
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
as $$
declare
  new_tenant_id uuid;
begin
  -- 1. Cria um novo Tenant/Escritório padrão para o usuário
  insert into public.tenants (name, plan, is_active)
  values ('Meu Novo Escritório', 'trial', true)
  returning id into new_tenant_id;

  -- 2. Cria o perfil do usuário vinculado ao Tenant recém-criado, com a role 'owner'
  insert into public.user_profiles (id, tenant_id, full_name, email, role, is_active)
  values (
    new.id, 
    new_tenant_id, 
    coalesce(new.raw_user_meta_data->>'full_name', 'Administrador'), 
    new.email, 
    'owner', 
    true
  );

  return new;
end;
$$;

-- Criar o gatilho (Trigger) na tabela auth.users do Supabase
create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
```

### 3. Conectar a Aplicação ao seu Supabase
Ao abrir a aplicação no navegador pela primeira vez, você será redirecionado para a aba de **Configurações**.
1. Cole a **API URL** do seu Supabase (encontrada em *Project Settings -> API*).
2. Cole a **Anon Key** do seu Supabase (encontrada em *Project Settings -> API*).
3. Clique em **Salvar Conexão**. O status de conexão mudará para verde e você poderá criar sua conta ou fazer login!

---

## 🔒 Regras Contábeis Implementadas no Frontend

O sistema foi programado para respeitar estritamente as regras de negócio declaradas no banco:
- **Compliance de Terceiros**: Movimentações marcadas como `transitorio_terceiros` (dinheiro de terceiros) **obrigatoriamente** exigem a seleção de um Processo/Caso.
- **Faturamento por Timesheet**: Ao cadastrar horas no Timesheet, o valor total faturado é calculado automaticamente baseado na fórmula `Horas * Valor/Hora`.
- **Validação de Rateio (Splits)**: Nas regras de divisão de honorários de cada caso, a interface exibe graficamente a soma das porcentagens e emite alertas se a divisão não totalizar exatamente 100%.
- **Separação de Caixas**: O Dashboard exibe saldos apartados do caixa **Operacional** (dinheiro do escritório) e do caixa **Transitório** (terceiros), permitindo conciliação e compliance total com as regras da OAB.
