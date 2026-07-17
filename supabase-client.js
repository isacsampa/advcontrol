/**
 * supabase-client.js
 * Camada de comunicação com a API do Supabase (Auth + CRUD).
 * Utiliza o cliente do Supabase carregado via CDN no index.html.
 */

let supabaseInstance = null;

// =========================================================================
// CONFIGURAÇÕES DE CONEXÃO DO SUPABASE
// =========================================================================
const SUPABASE_URL = 'https://becotkevgluahhisyxrr.supabase.co';
const SUPABASE_KEY = 'sb_publishable_UwT3uRZVQiHqToKlMfiRow_45c85BoQ'; // Cole sua Anon Key do Supabase aqui. Se deixada vazia, o sistema continuará buscando do navegador (localStorage).

/**
 * Retorna as credenciais salvas (no código ou no localStorage)
 */
function getSavedCredentials() {
  return {
    url: localStorage.getItem('supabase_url') || SUPABASE_URL || '',
    key: localStorage.getItem('supabase_key') || SUPABASE_KEY || ''
  };
}

/**
 * Verifica se o Supabase está configurado
 */
function isSupabaseConfigured() {
  const { url, key } = getSavedCredentials();
  return !!(url && key);
}

/**
 * Inicializa a instância do Supabase
 */
function initSupabase(url, key) {
  if (!url || !key) {
    throw new Error("URL e chave API são obrigatórias.");
  }
  localStorage.setItem('supabase_url', url);
  localStorage.setItem('supabase_key', key);

  // Limpa a instância anterior para forçar recriação
  supabaseInstance = null;

  // Tenta criar a conexão
  return getSupabaseClient() !== null;
}

/**
 * Retorna ou cria a instância única do cliente Supabase
 */
function getSupabaseClient() {
  if (supabaseInstance) return supabaseInstance;

  const { url, key } = getSavedCredentials();
  if (!url || !key) return null;

  try {
    // supabase é exposto globalmente pelo script do CDN
    if (typeof supabase === 'undefined') {
      console.error("SDK do Supabase não foi carregado pelo CDN.");
      return null;
    }
    supabaseInstance = supabase.createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true
      }
    });
    return supabaseInstance;
  } catch (error) {
    console.error("Erro ao inicializar Supabase client:", error);
    return null;
  }
}

// =========================================================================
// 1. AUTENTICAÇÃO
// =========================================================================

async function signUpUser(email, password, fullName, tenantId = null, role = null) {
  const client = getSupabaseClient();
  if (!client) throw new Error("Supabase não configurado.");

  const signUpParams = {
    email,
    password,
    options: {
      data: {
        full_name: fullName
      }
    }
  };

  if (tenantId) {
    signUpParams.options.data.tenant_id = tenantId;
  }
  if (role) {
    signUpParams.options.data.role = role;
  }

  const { data, error } = await client.auth.signUp(signUpParams);

  if (error) throw error;
  return data;
}

async function signInUser(email, password) {
  const client = getSupabaseClient();
  if (!client) throw new Error("Supabase não configurado.");

  const { data, error } = await client.auth.signInWithPassword({
    email,
    password
  });

  if (error) throw error;
  return data;
}

async function signOutUser() {
  const client = getSupabaseClient();
  if (!client) return;
  const { error } = await client.auth.signOut();
  if (error) throw error;
}

async function getCurrentSession() {
  const client = getSupabaseClient();
  if (!client) return null;
  try {
    const { data, error } = await client.auth.getSession();
    if (error) {
      console.warn("Erro ao obter sessão no getSession:", error);
      return null;
    }
    return data.session;
  } catch (err) {
    console.warn("Exceção capturada no getCurrentSession:", err);
    return null;
  }
}

/**
 * Recupera o perfil do usuário logado na tabela user_profiles
 */
async function getCurrentUserProfile(userId) {
  const client = getSupabaseClient();
  if (!client) return _getUserProfileLocalStorage(userId);

  try {
    const { data, error } = await client
      .from('user_profiles')
      .select('*, tenants(*)')
      .eq('id', userId)
      .single();

    if (error) {
      console.warn("Erro ao obter user profile do Supabase, tentando LocalStorage:", error);
      return _getUserProfileLocalStorage(userId);
    }

    if (data) {
      localStorage.setItem(`advcontrol_profile_${userId}`, JSON.stringify(data));
      return data;
    }
    return _getUserProfileLocalStorage(userId);
  } catch (err) {
    console.warn("Erro ao obter user profile (catch), tentando LocalStorage:", err);
    return _getUserProfileLocalStorage(userId);
  }
}

function _getUserProfileLocalStorage(userId) {
  const cached = localStorage.getItem(`advcontrol_profile_${userId}`);
  if (cached) {
    return JSON.parse(cached);
  }

  // Reconstrói a partir do usuário autenticado no Supabase (se houver sessão salva localmente)
  try {
    const client = getSupabaseClient();
    if (client) {
      // Localiza o token de autenticação no localStorage gerado pelo SDK
      const projectRef = client.supabaseUrl.split('//')[1].split('.')[0];
      const sessionString = localStorage.getItem(`sb-${projectRef}-auth-token`);
      if (sessionString) {
        const sessionData = JSON.parse(sessionString);
        const user = sessionData?.user;
        if (user && user.id === userId) {
          const mockProfile = {
            id: user.id,
            full_name: user.user_metadata?.full_name || user.email.split('@')[0],
            role: user.user_metadata?.role || 'owner',
            tenant_id: user.user_metadata?.tenant_id || 'local_tenant_default',
            tenants: {
              id: user.user_metadata?.tenant_id || 'local_tenant_default',
              name: 'Escritório Local'
            }
          };
          localStorage.setItem(`advcontrol_profile_${userId}`, JSON.stringify(mockProfile));
          return mockProfile;
        }
      }
    }
  } catch (e) {
    console.error("Erro ao reconstruir perfil a partir da sessão:", e);
  }
  return null;
}

// =========================================================================
// 2. CLIENTES (CRUD)
// =========================================================================

async function getClients() {
  const client = getSupabaseClient();
  if (!client) return _getClientsLocalStorage();

  try {
    const { data, error } = await client
      .from('clients')
      .select('*')
      .order('name', { ascending: true });

    if (error) {
      console.warn("Erro ao carregar clientes do Supabase. Usando LocalStorage fallback.", error);
      return _getClientsLocalStorage();
    }
    return data || [];
  } catch (err) {
    console.warn("Falha de conexão com Supabase. Usando LocalStorage fallback.", err);
    return _getClientsLocalStorage();
  }
}

async function createClient(tenantId, clientData) {
  const client = getSupabaseClient();
  if (!client) return _createClientLocalStorage(tenantId, clientData);

  try {
    const { data, error } = await client
      .from('clients')
      .insert([{ tenant_id: tenantId, ...clientData }])
      .select();

    if (error) {
      console.warn("Erro ao inserir cliente no Supabase. Gravando localmente.", error);
      return _createClientLocalStorage(tenantId, clientData);
    }
    return data[0];
  } catch (err) {
    console.warn("Falha ao salvar no Supabase. Gravando no LocalStorage.", err);
    return _createClientLocalStorage(tenantId, clientData);
  }
}

async function updateClient(clientId, clientData) {
  const client = getSupabaseClient();
  if (!client) return _updateClientLocalStorage(clientId, clientData);

  try {
    const { data, error } = await client
      .from('clients')
      .update(clientData)
      .eq('id', clientId)
      .select();

    if (error) {
      console.warn("Erro ao atualizar cliente no Supabase. Gravando localmente.", error);
      return _updateClientLocalStorage(clientId, clientData);
    }
    return data[0];
  } catch (err) {
    console.warn("Falha ao atualizar no Supabase. Gravando no LocalStorage.", err);
    return _updateClientLocalStorage(clientId, clientData);
  }
}

async function deleteClient(clientId) {
  const client = getSupabaseClient();
  if (!client) return _deleteClientLocalStorage(clientId);

  try {
    const { error } = await client
      .from('clients')
      .delete()
      .eq('id', clientId);

    if (error) {
      console.warn("Erro ao deletar cliente no Supabase. Deletando localmente.", error);
      return _deleteClientLocalStorage(clientId);
    }
    return true;
  } catch (err) {
    console.warn("Falha de conexão ao deletar no Supabase. Deletando localmente.", err);
    return _deleteClientLocalStorage(clientId);
  }
}

// Helpers de fallback para o LocalStorage - Clientes
function _getClientsLocalStorage() {
  return JSON.parse(localStorage.getItem('advcontrol_clients') || '[]');
}

function _createClientLocalStorage(tenantId, clientData) {
  const list = JSON.parse(localStorage.getItem('advcontrol_clients') || '[]');
  const newItem = {
    id: 'local_client_' + Math.random().toString(36).substr(2, 9),
    tenant_id: tenantId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...clientData
  };
  list.push(newItem);
  localStorage.setItem('advcontrol_clients', JSON.stringify(list));
  return newItem;
}

function _updateClientLocalStorage(clientId, clientData) {
  const list = JSON.parse(localStorage.getItem('advcontrol_clients') || '[]');
  const idx = list.findIndex(c => c.id === clientId);
  if (idx !== -1) {
    list[idx] = { ...list[idx], ...clientData, updated_at: new Date().toISOString() };
    localStorage.setItem('advcontrol_clients', JSON.stringify(list));
    return list[idx];
  }
  return null;
}

function _deleteClientLocalStorage(clientId) {
  let list = JSON.parse(localStorage.getItem('advcontrol_clients') || '[]');
  list = list.filter(c => c.id !== clientId);
  localStorage.setItem('advcontrol_clients', JSON.stringify(list));
  return true;
}

// =========================================================================
// 3. CASOS / PROCESSOS (CRUD)
// =========================================================================

async function getCases() {
  const client = getSupabaseClient();
  if (!client) return _getCasesLocalStorage();

  try {
    // Realiza o join com a tabela de clientes e perfis de sócios
    const { data, error } = await client
      .from('cases')
      .select(`
        *,
        clients(name),
        originating:user_profiles!cases_originating_partner_id_fkey(full_name),
        responsible:user_profiles!cases_responsible_partner_id_fkey(full_name)
      `)
      .order('title', { ascending: true });

    if (error) {
      console.warn("Erro ao ler Casos do Supabase. Usando LocalStorage fallback.", error);
      return _getCasesLocalStorage();
    }
    return data || [];
  } catch (err) {
    console.warn("Falha de conexão ao ler Casos. Usando LocalStorage fallback.", err);
    return _getCasesLocalStorage();
  }
}

async function createCase(tenantId, caseData) {
  const client = getSupabaseClient();
  if (!client) return _createCaseLocalStorage(tenantId, caseData);

  try {
    const { data, error } = await client
      .from('cases')
      .insert([{ tenant_id: tenantId, ...caseData }])
      .select();

    if (error) {
      console.warn("Erro ao criar caso no Supabase. Gravando localmente.", error);
      return _createCaseLocalStorage(tenantId, caseData);
    }
    return data[0];
  } catch (err) {
    console.warn("Falha ao salvar caso no Supabase. Gravando no LocalStorage.", err);
    return _createCaseLocalStorage(tenantId, caseData);
  }
}

async function updateCase(caseId, caseData) {
  const client = getSupabaseClient();
  if (!client) return _updateCaseLocalStorage(caseId, caseData);

  try {
    const { data, error } = await client
      .from('cases')
      .update(caseData)
      .eq('id', caseId)
      .select();

    if (error) {
      console.warn("Erro ao atualizar caso no Supabase. Gravando localmente.", error);
      return _updateCaseLocalStorage(caseId, caseData);
    }
    return data[0];
  } catch (err) {
    console.warn("Falha ao atualizar caso no Supabase. Gravando no LocalStorage.", err);
    return _updateCaseLocalStorage(caseId, caseData);
  }
}

async function deleteCase(caseId) {
  const client = getSupabaseClient();
  if (!client) return _deleteCaseLocalStorage(caseId);

  try {
    const { error } = await client
      .from('cases')
      .delete()
      .eq('id', caseId);

    if (error) {
      console.warn("Erro ao deletar caso no Supabase. Deletando localmente.", error);
      return _deleteCaseLocalStorage(caseId);
    }
    return true;
  } catch (err) {
    console.warn("Falha ao deletar caso no Supabase. Deletando localmente.", err);
    return _deleteCaseLocalStorage(caseId);
  }
}

// Helpers de fallback para o LocalStorage - Casos
function _getCasesLocalStorage() {
  const list = JSON.parse(localStorage.getItem('advcontrol_cases') || '[]');
  const clients = JSON.parse(localStorage.getItem('advcontrol_clients') || '[]');
  const members = JSON.parse(localStorage.getItem('advcontrol_members') || '[]');

  return list.map(item => {
    const cl = clients.find(c => c.id === item.client_id);
    const orig = members.find(m => m.id === item.originating_partner_id);
    const resp = members.find(m => m.id === item.responsible_partner_id);
    return {
      ...item,
      clients: cl ? { name: cl.name } : null,
      originating: orig ? { full_name: orig.full_name } : null,
      responsible: resp ? { full_name: resp.full_name } : null
    };
  });
}

function _createCaseLocalStorage(tenantId, caseData) {
  const list = JSON.parse(localStorage.getItem('advcontrol_cases') || '[]');
  const newItem = {
    id: 'local_case_' + Math.random().toString(36).substr(2, 9),
    tenant_id: tenantId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...caseData
  };
  list.push(newItem);
  localStorage.setItem('advcontrol_cases', JSON.stringify(list));
  return newItem;
}

function _updateCaseLocalStorage(caseId, caseData) {
  const list = JSON.parse(localStorage.getItem('advcontrol_cases') || '[]');
  const idx = list.findIndex(c => c.id === caseId);
  if (idx !== -1) {
    list[idx] = { ...list[idx], ...caseData, updated_at: new Date().toISOString() };
    localStorage.setItem('advcontrol_cases', JSON.stringify(list));
    return list[idx];
  }
  return null;
}

function _deleteCaseLocalStorage(caseId) {
  let list = JSON.parse(localStorage.getItem('advcontrol_cases') || '[]');
  list = list.filter(c => c.id !== caseId);
  localStorage.setItem('advcontrol_cases', JSON.stringify(list));
  return true;
}

// =========================================================================
// 4. TRANSAÇÕES / LANÇAMENTOS (CRUD)
// =========================================================================

async function getTransactions() {
  const client = getSupabaseClient();
  if (!client) return [];

  try {
    const { data, error } = await client
      .from('transactions')
      .select(`
        *,
        clients(name),
        cases(title, case_number),
        user_profiles!transactions_recorded_by_fkey(full_name)
      `)
      .order('due_date', { ascending: false });

    if (error) {
      console.warn("Erro ao buscar transações do Supabase:", error);
      return [];
    }
    return data || [];
  } catch (err) {
    console.warn("Falha ao ler transações:", err);
    return [];
  }
}

async function createTransaction(tenantId, recordedById, transData) {
  const client = getSupabaseClient();
  if (!client) throw new Error("Supabase não configurado.");

  // Regra contábil crítica: transitorio_terceiros exige case_id
  if (transData.cash_type === 'transitorio_terceiros' && !transData.case_id) {
    throw new Error("Transações do tipo 'Transitório (Terceiros)' devem obrigatoriamente estar vinculadas a um Processo/Caso.");
  }

  const payload = {
    tenant_id: tenantId,
    recorded_by: recordedById,
    ...transData
  };

  const { data, error } = await client
    .from('transactions')
    .insert([payload])
    .select();

  if (error) throw error;
  return data[0];
}

async function createTransactionsBulk(payloadArray) {
  const client = getSupabaseClient();
  if (!client) throw new Error("Supabase não configurado.");

  // Valida compliance para todos do array
  payloadArray.forEach(p => {
    if (p.cash_type === 'transitorio_terceiros' && !p.case_id) {
      throw new Error("Transações do tipo 'Transitório (Terceiros)' devem obrigatoriamente estar vinculadas a um Processo/Caso.");
    }
  });

  const { data, error } = await client
    .from('transactions')
    .insert(payloadArray)
    .select();

  if (error) throw error;
  return data;
}

async function updateTransaction(transId, transData) {
  const client = getSupabaseClient();
  if (!client) throw new Error("Supabase não configurado.");

  if (transData.cash_type === 'transitorio_terceiros' && !transData.case_id) {
    throw new Error("Transações do tipo 'Transitório (Terceiros)' devem obrigatoriamente estar vinculadas a um Processo/Caso.");
  }

  const { data, error } = await client
    .from('transactions')
    .update(transData)
    .eq('id', transId)
    .select();

  if (error) throw error;
  return data[0];
}

async function deleteTransaction(transId) {
  const client = getSupabaseClient();
  if (!client) throw new Error("Supabase não configurado.");

  const { error } = await client
    .from('transactions')
    .delete()
    .eq('id', transId);

  if (error) throw error;
  return true;
}

// =========================================================================
// 5. TIMESHEETS (CRUD)
// =========================================================================

async function getTimesheets() {
  const client = getSupabaseClient();
  if (!client) return [];

  try {
    const { data, error } = await client
      .from('timesheets')
      .select(`
        *,
        cases(title),
        user_profiles(full_name)
      `)
      .order('work_date', { ascending: false });

    if (error) {
      console.warn("Erro ao buscar timesheets do Supabase:", error);
      return [];
    }
    return data || [];
  } catch (err) {
    console.warn("Falha ao ler timesheets:", err);
    return [];
  }
}

async function createTimesheet(tenantId, timesheetData) {
  const client = getSupabaseClient();
  if (!client) throw new Error("Supabase não configurado.");

  const { data, error } = await client
    .from('timesheets')
    .insert([{ tenant_id: tenantId, ...timesheetData }])
    .select();

  if (error) throw error;
  return data[0];
}

async function updateTimesheet(timesheetId, timesheetData) {
  const client = getSupabaseClient();
  if (!client) throw new Error("Supabase não configurado.");

  const { data, error } = await client
    .from('timesheets')
    .update(timesheetData)
    .eq('id', timesheetId)
    .select();

  if (error) throw error;
  return data[0];
}

async function deleteTimesheet(timesheetId) {
  const client = getSupabaseClient();
  if (!client) throw new Error("Supabase não configurado.");

  const { error } = await client
    .from('timesheets')
    .delete()
    .eq('id', timesheetId);

  if (error) throw error;
  return true;
}

// =========================================================================
// 6. REGRAS DE RATEIO / SPLIT RULES
// =========================================================================

async function getSplitRules(caseId) {
  const client = getSupabaseClient();
  if (!client) return [];

  const { data, error } = await client
    .from('split_rules')
    .select(`
      *,
      user_profiles(full_name)
    `)
    .eq('case_id', caseId)
    .order('percentage', { ascending: false });

  if (error) throw error;
  return data;
}

async function saveSplitRules(tenantId, caseId, rulesArray) {
  const client = getSupabaseClient();
  if (!client) throw new Error("Supabase não configurado.");

  // 1. Remove regras existentes para o caso
  const { error: deleteError } = await client
    .from('split_rules')
    .delete()
    .eq('case_id', caseId);

  if (deleteError) throw deleteError;

  if (rulesArray.length === 0) return true;

  // 2. Prepara o payload para inserção em massa
  const payload = rulesArray.map(rule => ({
    tenant_id: tenantId,
    case_id: caseId,
    user_profile_id: rule.user_profile_id || null,
    split_role: rule.split_role,
    percentage: parseFloat(rule.percentage)
  }));

  const { error: insertError } = await client
    .from('split_rules')
    .insert(payload);

  if (insertError) throw insertError;
  return true;
}

// =========================================================================
// 7. PERFIS DE USUÁRIOS / EQUIPE
// =========================================================================

async function getUserProfiles() {
  const client = getSupabaseClient();
  if (!client) return [];

  try {
    const { data, error } = await client
      .from('user_profiles')
      .select('*')
      .order('full_name', { ascending: true });

    if (error) {
      console.warn("Erro ao buscar perfis de usuário do Supabase:", error);
      return [];
    }
    return data || [];
  } catch (err) {
    console.warn("Falha ao ler perfis de usuário:", err);
    return [];
  }
}

async function updateUserProfile(profileId, profileData) {
  const client = getSupabaseClient();
  if (!client) throw new Error("Supabase não configurado.");

  const { data, error } = await client
    .from('user_profiles')
    .update(profileData)
    .eq('id', profileId)
    .select();

  if (error) throw error;
  return data[0];
}

async function deleteUserProfile(profileId) {
  const client = getSupabaseClient();
  if (!client) throw new Error("Supabase não configurado.");

  const { error } = await client
    .from('user_profiles')
    .delete()
    .eq('id', profileId);

  if (error) throw error;
  return true;
}

// =========================================================================
// 8. TAREFAS INTERNAS (org_tasks)
// =========================================================================

/**
 * Busca todas as tarefas do tenant, ordenadas por prazo e status
 */
async function getOrgTasks() {
  const client = getSupabaseClient();
  if (!client) return _getOrgTasksLocalStorage();

  try {
    const { data, error } = await client
      .from('org_tasks')
      .select('*')
      .order('done', { ascending: true })
      .order('deadline', { ascending: true });

    if (error) {
      console.warn("Erro ao buscar tarefas do Supabase. Usando LocalStorage fallback.", error);
      return _getOrgTasksLocalStorage();
    }
    return data || [];
  } catch (err) {
    console.warn("Falha ao buscar tarefas no Supabase. Usando LocalStorage fallback.", err);
    return _getOrgTasksLocalStorage();
  }
}

/**
 * Cria uma nova tarefa interna
 */
async function createOrgTask(tenantId, taskData) {
  const client = getSupabaseClient();
  if (!client) return _createOrgTaskLocalStorage(tenantId, taskData);

  try {
    const { data, error } = await client
      .from('org_tasks')
      .insert([{ tenant_id: tenantId, ...taskData }])
      .select();

    if (error) {
      console.warn("Erro ao criar tarefa no Supabase. Gravando localmente.", error);
      return _createOrgTaskLocalStorage(tenantId, taskData);
    }
    return data[0];
  } catch (err) {
    console.warn("Falha ao criar tarefa no Supabase. Gravando localmente.", err);
    return _createOrgTaskLocalStorage(tenantId, taskData);
  }
}

/**
 * Alterna o status de conclusão de uma tarefa
 */
async function toggleOrgTaskDone(taskId, isDone) {
  const client = getSupabaseClient();
  if (!client) return _toggleOrgTaskDoneLocalStorage(taskId, isDone);

  const updateData = {
    done: isDone,
    done_at: isDone ? new Date().toISOString() : null
  };

  try {
    const { data, error } = await client
      .from('org_tasks')
      .update(updateData)
      .eq('id', taskId)
      .select();

    if (error) {
      console.warn("Erro ao atualizar status da tarefa no Supabase. Gravando localmente.", error);
      return _toggleOrgTaskDoneLocalStorage(taskId, isDone);
    }
    return data[0];
  } catch (err) {
    console.warn("Falha ao atualizar status da tarefa no Supabase. Gravando localmente.", err);
    return _toggleOrgTaskDoneLocalStorage(taskId, isDone);
  }
}

/**
 * Deleta uma tarefa interna
 */
async function deleteOrgTask(taskId) {
  const client = getSupabaseClient();
  if (!client) return _deleteOrgTaskLocalStorage(taskId);

  try {
    const { error } = await client
      .from('org_tasks')
      .delete()
      .eq('id', taskId);

    if (error) {
      console.warn("Erro ao deletar tarefa no Supabase. Deletando localmente.", error);
      return _deleteOrgTaskLocalStorage(taskId);
    }
    return true;
  } catch (err) {
    console.warn("Falha ao deletar tarefa no Supabase. Deletando localmente.", err);
    return _deleteOrgTaskLocalStorage(taskId);
  }
}

// Helpers de fallback para o LocalStorage - Tarefas Internas
function _getOrgTasksLocalStorage() {
  return JSON.parse(localStorage.getItem('advcontrol_org_tasks') || '[]');
}

function _createOrgTaskLocalStorage(tenantId, taskData) {
  const list = JSON.parse(localStorage.getItem('advcontrol_org_tasks') || '[]');
  const newItem = {
    id: 'local_task_' + Math.random().toString(36).substr(2, 9),
    tenant_id: tenantId,
    done: false,
    done_at: null,
    created_at: new Date().toISOString(),
    ...taskData
  };
  list.push(newItem);
  localStorage.setItem('advcontrol_org_tasks', JSON.stringify(list));
  return newItem;
}

function _toggleOrgTaskDoneLocalStorage(taskId, isDone) {
  const list = JSON.parse(localStorage.getItem('advcontrol_org_tasks') || '[]');
  const idx = list.findIndex(t => t.id === taskId);
  if (idx !== -1) {
    list[idx].done = isDone;
    list[idx].done_at = isDone ? new Date().toISOString() : null;
    localStorage.setItem('advcontrol_org_tasks', JSON.stringify(list));
    return list[idx];
  }
  return null;
}

function _deleteOrgTaskLocalStorage(taskId) {
  let list = JSON.parse(localStorage.getItem('advcontrol_org_tasks') || '[]');
  list = list.filter(t => t.id !== taskId);
  localStorage.setItem('advcontrol_org_tasks', JSON.stringify(list));
  return true;
}

// =========================================================================
// 9. AGENDA & COMPROMISSOS (appointments)
// =========================================================================

/**
 * Busca todos os compromissos da agenda do tenant
 */
async function getAppointments() {
  const client = getSupabaseClient();
  if (!client) return _getAppointmentsLocalStorage();

  try {
    const { data, error } = await client
      .from('appointments')
      .select(`
        *,
        clients(name),
        cases(title),
        user_profiles(full_name)
      `)
      .order('start_at', { ascending: true });

    if (error) {
      // Se a tabela não existir ainda no Supabase, usa o localStorage como fallback automático
      if (error.code === 'PGRST116' || error.message.includes('relation "appointments" does not exist')) {
        console.warn("Tabela 'appointments' não encontrada. Usando localStorage como fallback.");
        return _getAppointmentsLocalStorage();
      }
      throw error;
    }
    return data || [];
  } catch (err) {
    console.warn("Erro ao ler appointments do Supabase, usando localStorage fallback:", err);
    return _getAppointmentsLocalStorage();
  }
}

/**
 * Cria um novo compromisso
 */
async function createAppointment(tenantId, appointmentData) {
  const client = getSupabaseClient();
  if (!client) return _createAppointmentLocalStorage(tenantId, appointmentData);

  try {
    const { data, error } = await client
      .from('appointments')
      .insert([{ tenant_id: tenantId, ...appointmentData }])
      .select();

    if (error) {
      if (error.message.includes('relation "appointments" does not exist')) {
        return _createAppointmentLocalStorage(tenantId, appointmentData);
      }
      throw error;
    }
    return data[0];
  } catch (err) {
    console.warn("Erro ao salvar appointment no Supabase, usando localStorage:", err);
    return _createAppointmentLocalStorage(tenantId, appointmentData);
  }
}

/**
 * Deleta um compromisso
 */
async function deleteAppointment(appointmentId) {
  const client = getSupabaseClient();
  if (!client) return _deleteAppointmentLocalStorage(appointmentId);

  try {
    const { error } = await client
      .from('appointments')
      .delete()
      .eq('id', appointmentId);

    if (error) {
      if (error.message.includes('relation "appointments" does not exist')) {
        return _deleteAppointmentLocalStorage(appointmentId);
      }
      throw error;
    }
    return true;
  } catch (err) {
    console.warn("Erro ao deletar appointment no Supabase, usando localStorage:", err);
    return _deleteAppointmentLocalStorage(appointmentId);
  }
}

// --- HELPER LOCALSTORAGE FALLBACKS ---

function _getAppointmentsLocalStorage() {
  const list = JSON.parse(localStorage.getItem('advcontrol_appointments') || '[]');
  // Mapeia os joins locais para simular resposta do banco
  const clients = JSON.parse(localStorage.getItem('advcontrol_clients') || '[]');
  const cases = JSON.parse(localStorage.getItem('advcontrol_cases') || '[]');
  const members = JSON.parse(localStorage.getItem('advcontrol_members') || '[]');

  return list.map(item => {
    const cl = clients.find(c => c.id === item.client_id);
    const cs = cases.find(c => c.id === item.case_id);
    const mb = members.find(m => m.id === item.assignee_id);
    return {
      ...item,
      clients: cl ? { name: cl.name } : null,
      cases: cs ? { title: cs.title } : null,
      user_profiles: mb ? { full_name: mb.full_name } : (item.assignee_name ? { full_name: item.assignee_name } : null)
    };
  });
}

function _createAppointmentLocalStorage(tenantId, data) {
  const list = JSON.parse(localStorage.getItem('advcontrol_appointments') || '[]');
  const newItem = {
    id: 'local_' + Math.random().toString(36).substr(2, 9),
    tenant_id: tenantId,
    created_at: new Date().toISOString(),
    ...data
  };
  list.push(newItem);
  localStorage.setItem('advcontrol_appointments', JSON.stringify(list));
  return newItem;
}

function _deleteAppointmentLocalStorage(id) {
  let list = JSON.parse(localStorage.getItem('advcontrol_appointments') || '[]');
  list = list.filter(item => item.id !== id);
  localStorage.setItem('advcontrol_appointments', JSON.stringify(list));
  return true;
}

// =========================================================================
// 10. CONFIGURAÇÕES DO ESCRITÓRIO (tenant_settings)
// =========================================================================

async function getOfficeSettings(tenantId) {
  const client = getSupabaseClient();
  if (!client) return _getOfficeSettingsLocalStorage(tenantId);

  try {
    const { data, error } = await client
      .from('tenant_settings')
      .select('*')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (error) {
      if (error.code === 'PGRST116' || error.message.includes('relation "tenant_settings" does not exist')) {
        return _getOfficeSettingsLocalStorage(tenantId);
      }
      throw error;
    }
    return data || _getOfficeSettingsLocalStorage(tenantId);
  } catch (err) {
    console.warn("Erro ao buscar configurações no Supabase, usando localStorage fallback:", err);
    return _getOfficeSettingsLocalStorage(tenantId);
  }
}

async function updateOfficeSettings(tenantId, settingsData) {
  const client = getSupabaseClient();
  if (!client) return _updateOfficeSettingsLocalStorage(tenantId, settingsData);

  try {
    const payload = { tenant_id: tenantId, ...settingsData, updated_at: new Date().toISOString() };
    const { data, error } = await client
      .from('tenant_settings')
      .upsert(payload, { onConflict: 'tenant_id' })
      .select();

    if (error) {
      if (error.message.includes('relation "tenant_settings" does not exist')) {
        return _updateOfficeSettingsLocalStorage(tenantId, settingsData);
      }
      throw error;
    }
    return data[0];
  } catch (err) {
    console.warn("Erro ao salvar configurações no Supabase, usando localStorage fallback:", err);
    return _updateOfficeSettingsLocalStorage(tenantId, settingsData);
  }
}

function _getOfficeSettingsLocalStorage(tenantId) {
  const key = `advcontrol_settings_${tenantId}`;
  return JSON.parse(localStorage.getItem(key) || 'null');
}

function _updateOfficeSettingsLocalStorage(tenantId, settingsData) {
  const key = `advcontrol_settings_${tenantId}`;
  const existing = JSON.parse(localStorage.getItem(key) || '{}');
  const updated = {
    tenant_id: tenantId,
    ...existing,
    ...settingsData,
    updated_at: new Date().toISOString()
  };
  localStorage.setItem(key, JSON.stringify(updated));
  return updated;
}

window.getOfficeSettings = getOfficeSettings;
window.updateOfficeSettings = updateOfficeSettings;
