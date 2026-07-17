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
    url: SUPABASE_URL || localStorage.getItem('supabase_url') || '',
    key: SUPABASE_KEY || localStorage.getItem('supabase_key') || ''
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
  const { data, error } = await client.auth.getSession();
  if (error) return null;
  return data.session;
}

/**
 * Recupera o perfil do usuário logado na tabela user_profiles
 */
async function getCurrentUserProfile(userId) {
  const client = getSupabaseClient();
  if (!client) return null;

  const { data, error } = await client
    .from('user_profiles')
    .select('*, tenants(*)')
    .eq('id', userId)
    .single();

  if (error) {
    console.error("Erro ao obter user profile:", error);
    return null;
  }
  return data;
}

// =========================================================================
// 2. CLIENTES (CRUD)
// =========================================================================

async function getClients() {
  const client = getSupabaseClient();
  if (!client) return [];

  const { data, error } = await client
    .from('clients')
    .select('*')
    .order('name', { ascending: true });

  if (error) throw error;
  return data;
}

async function createClient(tenantId, clientData) {
  const client = getSupabaseClient();
  if (!client) throw new Error("Supabase não configurado.");

  const { data, error } = await client
    .from('clients')
    .insert([{ tenant_id: tenantId, ...clientData }])
    .select();

  if (error) throw error;
  return data[0];
}

async function updateClient(clientId, clientData) {
  const client = getSupabaseClient();
  if (!client) throw new Error("Supabase não configurado.");

  const { data, error } = await client
    .from('clients')
    .update(clientData)
    .eq('id', clientId)
    .select();

  if (error) throw error;
  return data[0];
}

async function deleteClient(clientId) {
  const client = getSupabaseClient();
  if (!client) throw new Error("Supabase não configurado.");

  const { error } = await client
    .from('clients')
    .delete()
    .eq('id', clientId);

  if (error) throw error;
  return true;
}

// =========================================================================
// 3. CASOS / PROCESSOS (CRUD)
// =========================================================================

async function getCases() {
  const client = getSupabaseClient();
  if (!client) return [];

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

  if (error) throw error;
  return data;
}

async function createCase(tenantId, caseData) {
  const client = getSupabaseClient();
  if (!client) throw new Error("Supabase não configurado.");

  const { data, error } = await client
    .from('cases')
    .insert([{ tenant_id: tenantId, ...caseData }])
    .select();

  if (error) throw error;
  return data[0];
}

async function updateCase(caseId, caseData) {
  const client = getSupabaseClient();
  if (!client) throw new Error("Supabase não configurado.");

  const { data, error } = await client
    .from('cases')
    .update(caseData)
    .eq('id', caseId)
    .select();

  if (error) throw error;
  return data[0];
}

async function deleteCase(caseId) {
  const client = getSupabaseClient();
  if (!client) throw new Error("Supabase não configurado.");

  const { error } = await client
    .from('cases')
    .delete()
    .eq('id', caseId);

  if (error) throw error;
  return true;
}

// =========================================================================
// 4. TRANSAÇÕES / LANÇAMENTOS (CRUD)
// =========================================================================

async function getTransactions() {
  const client = getSupabaseClient();
  if (!client) return [];

  const { data, error } = await client
    .from('transactions')
    .select(`
      *,
      clients(name),
      cases(title, case_number),
      user_profiles!transactions_recorded_by_fkey(full_name)
    `)
    .order('due_date', { ascending: false });

  if (error) throw error;
  return data;
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

  const { data, error } = await client
    .from('timesheets')
    .select(`
      *,
      cases(title),
      user_profiles(full_name)
    `)
    .order('work_date', { ascending: false });

  if (error) throw error;
  return data;
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

  const { data, error } = await client
    .from('user_profiles')
    .select('*')
    .order('full_name', { ascending: true });

  if (error) throw error;
  return data;
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
  if (!client) return [];

  const { data, error } = await client
    .from('org_tasks')
    .select('*')
    .order('done', { ascending: true })
    .order('deadline', { ascending: true });

  if (error) throw error;
  return data;
}

/**
 * Cria uma nova tarefa interna
 */
async function createOrgTask(tenantId, taskData) {
  const client = getSupabaseClient();
  if (!client) throw new Error("Supabase não configurado.");

  const { data, error } = await client
    .from('org_tasks')
    .insert([{ tenant_id: tenantId, ...taskData }])
    .select();

  if (error) throw error;
  return data[0];
}

/**
 * Alterna o status de conclusão de uma tarefa
 */
async function toggleOrgTaskDone(taskId, isDone) {
  const client = getSupabaseClient();
  if (!client) throw new Error("Supabase não configurado.");

  const updateData = {
    done: isDone,
    done_at: isDone ? new Date().toISOString() : null
  };

  const { data, error } = await client
    .from('org_tasks')
    .update(updateData)
    .eq('id', taskId)
    .select();

  if (error) throw error;
  return data[0];
}

/**
 * Deleta uma tarefa interna
 */
async function deleteOrgTask(taskId) {
  const client = getSupabaseClient();
  if (!client) throw new Error("Supabase não configurado.");

  const { error } = await client
    .from('org_tasks')
    .delete()
    .eq('id', taskId);

  if (error) throw error;
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
