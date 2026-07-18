/**
 * app.js
 * Roteamento do frontend SPA, gerenciamento de estado local,
 * manipulação de formulários, renderização de tabelas e gráficos.
 */

// =========================================================================
// ESTADO GLOBAL DA APLICAÇÃO
// =========================================================================
const AppState = {
  activeTab: 'dashboard',
  session: null,
  userProfile: null,
  // Cache de dados locais para joins e selects rápidos
  clients: [],
  cases: [],
  transactions: [],
  timesheets: [],
  members: [],
  orgTasks: [],
  // Instâncias dos gráficos do Chart.js
  charts: {
    flow: null,
    dist: null
  },
  // Controle de edição para Splits (regras de rateio)
  currentSplitCaseId: null
};

// =========================================================================
// CONTROLE DE ACESSO POR PAPEL (RBAC)
// =========================================================================

/** Abas permitidas por papel */
const TAB_PERMISSIONS = {
  owner:     ['dashboard', 'agenda', 'transactions', 'clients', 'cases', 'timesheets', 'members', 'billing-generator', 'organization', 'office-settings'],
  partner:   ['agenda', 'transactions', 'clients', 'cases', 'timesheets', 'billing-generator', 'organization'],
  financial: ['dashboard', 'agenda', 'transactions', 'clients', 'cases', 'billing-generator', 'organization'],
  associate: ['agenda', 'clients', 'cases', 'organization'],
  secretary: ['agenda', 'clients', 'cases', 'organization']
};

/** Ações permitidas por papel */
const ACTION_PERMISSIONS = {
  owner:     ['create', 'edit', 'delete', 'splits', 'manage_team', 'create_timesheets', 'view_all_timesheets'],
  partner:   ['create', 'edit', 'splits', 'create_timesheets', 'view_all_timesheets'],
  financial: ['create', 'edit'],
  associate: ['create_timesheets', 'edit_own_timesheets'],
  secretary: ['create', 'edit'],
};

/** Verifica se o usuário logado tem permissão para uma ação */
function hasPermission(action) {
  const role = AppState.userProfile?.role;
  if (!role) return false;
  return (ACTION_PERMISSIONS[role] || []).includes(action);
}

/** Verifica se a aba é acessível para o papel atual */
function canAccessTab(tabId) {
  const role = AppState.userProfile?.role;
  if (!role) return false;
  return (TAB_PERMISSIONS[role] || []).includes(tabId);
}

/**
 * Recupera o tenant_id ativo do usuário de forma blindada contra valores indefinidos.
 */
function getEffectiveTenantId() {
  if (AppState.userProfile?.tenant_id) return AppState.userProfile.tenant_id;
  
  // Tenta extrair da sessão ativa
  const session = AppState.session || JSON.parse(localStorage.getItem('advcontrol_session_cache') || 'null');
  if (session?.user) {
    if (session.user.user_metadata?.tenant_id) {
      return session.user.user_metadata.tenant_id;
    }
    const cachedProfile = JSON.parse(localStorage.getItem(`advcontrol_profile_${session.user.id}`) || 'null');
    if (cachedProfile?.tenant_id) {
      return cachedProfile.tenant_id;
    }
  }
  return null;
}

/**
 * Aplica restrições visuais no menu lateral baseadas no papel do usuário.
 * Exibe apenas as abas permitidas e atualiza o badge de papel.
 */
function applyNavPermissions() {
  const role = AppState.userProfile?.role;
  if (!role) return;

  const allowed = TAB_PERMISSIONS[role] || [];
  document.querySelectorAll('.nav-links li[data-view]').forEach(item => {
    const tabId = item.getAttribute('data-view');
    item.style.display = allowed.includes(tabId) ? '' : 'none';
  });


  const roleLabels = {
    owner:     '👑 Proprietário (Dono)',
    partner:   '🤝 Sócio',
    associate: '👤 Advogado Parceiro',
    financial: '💼 Assessor Jurídico',
    secretary: '📞 Secretária',
  };
  const roleEl = document.getElementById('sidebarUserRole');
  if (roleEl) roleEl.textContent = roleLabels[role] || role;
}

/** Utilitário: mostra ou oculta um elemento pelo ID */
function _setVisible(id, visible) {
  const el = document.getElementById(id);
  if (el) el.style.display = visible ? '' : 'none';
}

// =========================================================================
// ESTADO DO CONVITE (acessível globalmente pelo handler de cadastro)
// =========================================================================
let _inviteTenantId = null;
let _inviteRole = 'associate';

document.addEventListener('DOMContentLoaded', async () => {
  // Inicializa eventos globais de navegação
  initNavigation();
  initFormEventListeners();

  // Verifica se há convite de equipe na URL
  const urlParams = new URLSearchParams(window.location.search);
  _inviteTenantId = urlParams.get('tenant_id');
  _inviteRole    = urlParams.get('role') || 'associate';
  
  // Se houver convite na URL, muda a tela para o cadastro de convidado IMEDIATAMENTE
  if (_inviteTenantId) {
    _showInviteRegisterForm();
  }

  // Verifica configuração do Supabase
  if (!isSupabaseConfigured()) {
    showToast("Supabase não configurado.", "error");
    showAuthScreen(true);
    updateConnectionStatus(false);
    return;
  }

  let session = null;
  let connectionSuccess = false;

  try {
    const client = getSupabaseClient();
    if (client) {
      updateConnectionStatus(true);
      session = await getCurrentSession();
      connectionSuccess = true;
    } else {
      updateConnectionStatus(false);
    }
  } catch (err) {
    console.warn("Falha ao inicializar ou ler sessão do Supabase, tentando local cache:", err);
  }

  // Fallback Resiliente de Sessão: Se o Supabase estiver off/indisponível
  if (!session) {
    const cached = localStorage.getItem('advcontrol_session_cache');
    if (cached) {
      try {
        session = JSON.parse(cached);
        console.log("Resgatada sessão do cache local resiliente.");
      } catch (e) {
        console.error("Erro ao fazer parse da sessão em cache:", e);
      }
    }
  } else {
    // Se obteve com sucesso do Supabase, atualiza o cache local
    localStorage.setItem('advcontrol_session_cache', JSON.stringify(session));
  }

  // Executa o login ou redireciona
  try {
    if (session && _inviteTenantId) {
      // Usuário já logado abrindo link de convite → desloga e mostra cadastro
      if (connectionSuccess) {
        await signOutUser();
      }
      AppState.session = null;
      AppState.userProfile = null;
      localStorage.removeItem('advcontrol_session_cache');
      showAuthScreen(true);
      _showInviteRegisterForm();
    } else if (session) {
      await handleUserAuthenticated(session);
    } else {
      showAuthScreen(true);
      if (_inviteTenantId) {
        _showInviteRegisterForm();
      }
    }
  } catch (err) {
    console.error("Erro fatal no roteamento de sessão:", err);
    showAuthScreen(true);
  }
});

/**
 * Exibe o formulário de cadastro personalizado para convidados
 */
function _showInviteRegisterForm() {
  const roleLabel = _inviteRole === 'financial' ? 'Equipe Financeira' : 'Advogado Associado';
  const loginSection = document.getElementById('loginFormSection');
  const regSection   = document.getElementById('registerFormSection');
  const regTitle     = document.querySelector('#registerFormSection h2');
  const regDesc      = document.querySelector('#registerFormSection p');

  if (loginSection) loginSection.style.display = 'none';
  if (regSection)   regSection.style.display   = 'block';
  if (regTitle)     regTitle.textContent = '✉️ Convite de Equipe';
  if (regDesc)      regDesc.innerHTML   =
    `Você foi convidado para o escritório. Crie sua conta como <strong>${roleLabel}</strong>.`;
}

/**
 * Atualiza o indicador de status da conexão com o Supabase
 */
function updateConnectionStatus(isConnected) {
  const dot = document.getElementById('supabaseStatusDot');
  const text = document.getElementById('supabaseStatusText');
  
  if (isConnected) {
    dot.classList.add('connected');
    text.textContent = "Supabase Conectado";
  } else {
    dot.classList.remove('connected');
    text.textContent = "Supabase Desconectado";
  }
}

/**
 * Trata o estado de usuário logado
 */
async function handleUserAuthenticated(session) {
  AppState.session = session;
  showLoader(true);
  
  try {
    let profile = await getCurrentUserProfile(session.user.id);
    if (!profile) {
      console.warn("Perfil de usuário não encontrado no Supabase. Reconstruindo a partir dos metadados da sessão.");
      const user = session.user;
      profile = {
        id: user.id,
        full_name: user.user_metadata?.full_name || user.email.split('@')[0],
        role: user.user_metadata?.role || 'owner',
        tenant_id: user.user_metadata?.tenant_id || 'local_tenant_default',
        tenants: {
          id: user.user_metadata?.tenant_id || 'local_tenant_default',
          name: 'Escritório Local'
        }
      };
      localStorage.setItem(`advcontrol_profile_${user.id}`, JSON.stringify(profile));
    }
    
    AppState.userProfile = profile;
    showAuthScreen(false);
    
    // Atualiza cabeçalho do menu lateral
    document.getElementById('sidebarUserName').textContent = profile.full_name;
    document.getElementById('sidebarUserRole').textContent = `Papel: ${profile.role}`;
    document.getElementById('sidebarUserAvatar').textContent = profile.full_name.charAt(0).toUpperCase();
    
    // Carrega dados iniciais do banco
    await refreshAllData();

    // Lógica para verificar exibição do Assistente de Onboarding Inicial
    if (profile.role === 'owner' && (!AppState.officeSettings || !AppState.officeSettings.onboarding_completed)) {
      showOnboardingWizard(true);
    } else {
      showOnboardingWizard(false);
    }
    
    // Aplica restrições de navegação baseadas no papel do usuário
    applyNavPermissions();
    
    // Garante que a aba ativa é permitida para este papel, caso contrário vai para a primeira aba permitida
    const allowedTabs = TAB_PERMISSIONS[profile.role] || ['clients'];
    const targetTab = (canAccessTab(AppState.activeTab) && AppState.activeTab !== 'settings') ? AppState.activeTab : allowedTabs[0];
    switchTab(targetTab);
  } catch (error) {
    console.error(error);
    showToast("Erro ao carregar dados do usuário: " + error.message, "error");
  } finally {
    showLoader(false);
  }
}

// =========================================================================
// ROTEADOR SPA & MENUS
// =========================================================================
function initNavigation() {
  const navItems = document.querySelectorAll('.nav-links li[data-view]');
  const sidebar = document.querySelector('.sidebar');
  const backdrop = document.getElementById('sidebarBackdrop');

  function closeMobileMenu() {
    if (sidebar) sidebar.classList.remove('active');
    if (backdrop) backdrop.classList.remove('active');
  }

  navItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const tabId = item.getAttribute('data-view');
      switchTab(tabId);
      closeMobileMenu(); // Fecha o menu lateral no celular após clicar
    });
  });

  // Mobile drawer navigation toggles
  const mobileMenuBtn = document.getElementById('mobileMenuBtn');
  if (mobileMenuBtn) {
    mobileMenuBtn.addEventListener('click', () => {
      if (sidebar) sidebar.classList.add('active');
      if (backdrop) backdrop.classList.add('active');
    });
  }

  if (backdrop) {
    backdrop.addEventListener('click', closeMobileMenu);
  }


  // Listener para botões do formulário de autenticação
  document.getElementById('btnSwitchToRegister').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('loginFormSection').style.display = 'none';
    document.getElementById('registerFormSection').style.display = 'block';
  });

  document.getElementById('btnSwitchToLogin').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('registerFormSection').style.display = 'none';
    document.getElementById('loginFormSection').style.display = 'block';
  });

  // Botão de Logout
  document.getElementById('btnLogout').addEventListener('click', async () => {
    try {
      showLoader(true);
      await signOutUser();
      AppState.session = null;
      AppState.userProfile = null;
      localStorage.removeItem('advcontrol_session_cache');
      showToast("Sessão encerrada com sucesso.", "success");
      showAuthScreen(true);
    } catch (err) {
      showToast("Erro ao deslogar: " + err.message, "error");
    } finally {
      showLoader(false);
    }
  });
}

function switchTab(tabId) {
  // Se o Supabase não estiver configurado, avisa
  if (!isSupabaseConfigured()) {
    showToast("Configure as credenciais do Supabase no arquivo supabase-client.js.", "error");
    return;
  }
  
  // Se não estiver logado, exige login
  if (!AppState.session) {
    showAuthScreen(true);
    return;
  }

  // ── RBAC: bloqueia aba se o papel não tiver acesso ──
  if (AppState.userProfile && !canAccessTab(tabId)) {
    showToast(`Acesso restrito para o perfil "${AppState.userProfile.role}".`, 'warning');
    tabId = 'dashboard';
  }

  AppState.activeTab = tabId;
  
  // No celular, fecha o menu lateral automaticamente ao selecionar uma aba
  if (window.innerWidth <= 768) {
    const sidebar = document.querySelector('.sidebar');
    const backdrop = document.querySelector('.sidebar-backdrop');
    if (sidebar) sidebar.classList.remove('active');
    if (backdrop) backdrop.classList.remove('active');
  }
  
  // Atualiza classe active nos links laterais
  const navItems = document.querySelectorAll('.nav-links li[data-view]');
  navItems.forEach(item => {
    if (item.getAttribute('data-view') === tabId) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  // Alterna visibilidade dos painéis
  const viewPanes = document.querySelectorAll('.view-pane');
  viewPanes.forEach(pane => {
    if (pane.id === `view-${tabId}`) {
      pane.classList.add('active');
    } else {
      pane.classList.remove('active');
    }
  });

  // Altera cabeçalho de título
  const titleEl = document.getElementById('viewTitle');
  const subtitleEl = document.getElementById('viewSubtitle');
  
  switch(tabId) {
    case 'dashboard':
      titleEl.textContent = "Dashboard";
      subtitleEl.textContent = "Visão geral e conciliação contábil do escritório.";
      renderDashboard();
      break;
    case 'onboarding':
      titleEl.textContent = "Primeiros Passos";
      subtitleEl.textContent = "Guia de onboarding para configuração inicial do seu escritório.";
      renderOnboardingChecklist();
      break;
    case 'agenda':
      titleEl.textContent = "Agenda & Compromissos";
      subtitleEl.textContent = "Organize as reuniões, audiências e compromissos importantes do escritório.";
      initAgendaTab();
      break;

    case 'transactions':
      titleEl.textContent = "Lançamentos Financeiros";
      subtitleEl.textContent = "Gestão operacional do fluxo de caixa e fundos de terceiros.";
      renderTransactionsTable();
      // Controla botão Novo por papel
      _setVisible('btnNewTransaction', hasPermission('create'));
      break;
    case 'clients':
      titleEl.textContent = "Gestão de Clientes";
      subtitleEl.textContent = "Cadastro e controle de clientes ativos do escritório.";
      renderClientsTable();
      // Associate só visualiza, não cadastra
      _setVisible('btnNewClient', hasPermission('create'));
      break;
    case 'cases':
      titleEl.textContent = "Casos & Processos";
      subtitleEl.textContent = "Centros de custo e processos ativos com regras de rateio de honorários.";
      renderCasesTable();
      // Associate e financial não criam casos
      _setVisible('btnNewCase', hasPermission('create'));
      break;
    case 'timesheets':
      titleEl.textContent = "Registro de Timesheets";
      subtitleEl.textContent = "Controle de horas trabalhadas por advogado em cada caso.";
      renderTimesheetsTable();
      // Associate pode registrar apenas os próprios
      _setVisible('btnNewTimesheet', hasPermission('create_timesheets'));
      break;
    case 'members':
      titleEl.textContent = "Equipe / Advogados";
      subtitleEl.textContent = "Controle de acesso, papéis administrativos e taxas horárias.";
      renderMembersTable();
      break;
    case 'billing-generator':
      titleEl.textContent = "Carnê de Pagamento";
      subtitleEl.textContent = "Geração de carnê de cobranças em formato PDF pronto para impressão.";
      initBillingGeneratorTab();
      break;
    case 'organization':
      titleEl.textContent = "Organização & Fluxos";
      subtitleEl.textContent = "Gestão de tarefas internas, checklists de documentos e procedimentos jurídicos.";
      initOrganizationTab();
      break;
    case 'office-settings':
      titleEl.textContent = "Configurações do Escritório";
      subtitleEl.textContent = "Defina os dados institucionais, identidade visual e faturamento.";
      initOfficeSettingsTab();
      break;
  }
}

function showAuthScreen(show) {
  const authContainer = document.getElementById('authContainer');
  if (show) {
    authContainer.classList.add('active');
  } else {
    authContainer.classList.remove('active');
  }
}

// =========================================================================
// CARGA DE DADOS DO SUPABASE (Sincronização de cache local)
// =========================================================================
async function refreshAllData() {
  if (!isSupabaseConfigured() || !AppState.session) return;
  
  try {
    const [clients, cases, transactions, timesheets, members, orgTasks, appointments, settings] = await Promise.all([
      getClients(),
      getCases(),
      getTransactions(),
      getTimesheets(),
      getUserProfiles(),
      getOrgTasks(),
      getAppointments(),
      getOfficeSettings(AppState.userProfile.tenant_id)
    ]);
    
    AppState.clients = clients || [];
    AppState.cases = cases || [];
    AppState.transactions = transactions || [];
    AppState.timesheets = timesheets || [];
    AppState.members = members || [];
    AppState.orgTasks = orgTasks || [];
    AppState.appointments = appointments || [];
    AppState.officeSettings = settings || null;

    // Aplica o tema visual do escritório
    applyOfficeTheme(AppState.officeSettings);
    
    // Atualiza a lista interativa de onboarding se estiver configurada
    if (typeof renderOnboardingChecklist === 'function') {
      renderOnboardingChecklist();
    }
  } catch (error) {
    console.error("Erro ao sincronizar tabelas:", error);
    showToast("Erro ao sincronizar tabelas: " + error.message, "error");
  }
}

// =========================================================================
// RENDERIZAÇÃO: DASHBOARD & GRÁFICOS
// =========================================================================
function renderDashboard() {
  // 1. Cálculos de Indicadores baseados em transações
  let valCashOperational = 0;
  let valCashThirdParty = 0;
  let valTotalRevenue = 0;
  let valTotalExpenses = 0;
  
  const now = new Date();
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();

  AppState.transactions.forEach(t => {
    const isPaid = t.status === 'pago';
    const amount = parseFloat(t.amount);
    
    // Saldos cumulativos (apenas pagos)
    if (isPaid) {
      if (t.cash_type === 'operacional') {
        if (t.movement_type === 'receita') valCashOperational += amount;
        else valCashOperational -= amount;
      } else if (t.cash_type === 'transitorio_terceiros') {
        if (t.movement_type === 'receita') valCashThirdParty += amount;
        else valCashThirdParty -= amount;
      }
    }
    
    // Receitas e Despesas do Mês Atual (pagas)
    if (isPaid && t.due_date) {
      const [tYear, tMonth] = t.due_date.split('-').map(Number);
      if ((tMonth - 1) === currentMonth && tYear === currentYear) {
        if (t.movement_type === 'receita') {
          valTotalRevenue += amount;
        } else {
          valTotalExpenses += amount;
        }
      }
    }
  });

  // Atualiza widgets na tela
  document.getElementById('valCashOperational').textContent = formatCurrency(valCashOperational);
  document.getElementById('valCashThirdParty').textContent = formatCurrency(valCashThirdParty);
  document.getElementById('valTotalRevenue').textContent = formatCurrency(valTotalRevenue);
  document.getElementById('valTotalExpenses').textContent = formatCurrency(valTotalExpenses);

  // 2. Gráfico 1: Fluxo de Caixa (Mensal) - Receita vs Despesa
  // Agrupa dados dos últimos 6 meses
  const monthNames = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
  const last6Months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    last6Months.push({
      month: d.getMonth(),
      year: d.getFullYear(),
      name: `${monthNames[d.getMonth()]}/${d.getFullYear().toString().substring(2)}`,
      revenue: 0,
      expense: 0
    });
  }

  AppState.transactions.forEach(t => {
    if (t.status === 'pago' && t.due_date) {
      const [tYear, tMonth] = t.due_date.split('-').map(Number);
      const amount = parseFloat(t.amount);
      
      const match = last6Months.find(m => m.month === (tMonth - 1) && m.year === tYear);
      if (match) {
        if (t.movement_type === 'receita') match.revenue += amount;
        else match.expense += amount;
      }
    }
  });

  const ctxFlow = document.getElementById('flowChart').getContext('2d');
  if (AppState.charts.flow) AppState.charts.flow.destroy();

  AppState.charts.flow = new Chart(ctxFlow, {
    type: 'bar',
    data: {
      labels: last6Months.map(m => m.name),
      datasets: [
        {
          label: 'Receitas (R$)',
          data: last6Months.map(m => m.revenue),
          backgroundColor: '#10b981',
          borderRadius: 4
        },
        {
          label: 'Despesas (R$)',
          data: last6Months.map(m => m.expense),
          backgroundColor: '#ef4444',
          borderRadius: 4
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: { color: '#9ca3af', font: { family: 'Plus Jakarta Sans' } }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: '#9ca3af' }
        },
        y: {
          grid: { color: 'rgba(255,255,255,0.05)' },
          ticks: { color: '#9ca3af' }
        }
      }
    }
  });

  // 3. Gráfico 2: Distribuição de Caixa (Operacional vs Terceiros)
  const ctxDist = document.getElementById('distChart').getContext('2d');
  if (AppState.charts.dist) AppState.charts.dist.destroy();

  AppState.charts.dist = new Chart(ctxDist, {
    type: 'doughnut',
    data: {
      labels: ['Operacional', 'Transitório (Terceiros)'],
      datasets: [{
        data: [Math.max(0, valCashOperational), Math.max(0, valCashThirdParty)],
        backgroundColor: ['#6366f1', '#3b82f6'],
        borderWidth: 2,
        borderColor: '#0f1524'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: '#9ca3af', font: { family: 'Plus Jakarta Sans' } }
        }
      }
    }
  });
}

// =========================================================================
// RENDERIZAÇÃO: TABELA DE LANÇAMENTOS (TRANSAÇÕES)
// =========================================================================
function renderTransactionsTable() {
  const container = document.getElementById('transactionsGroupedContainer');
  container.innerHTML = '';

  const search = document.getElementById('searchTransaction').value.toLowerCase();
  const cashType = document.getElementById('filterCashType').value;
  const moveType = document.getElementById('filterMovementType').value;
  const status = document.getElementById('filterStatus').value;

  const filtered = AppState.transactions.filter(t => {
    const clientName = t.clients?.name || '';
    const caseTitle = t.cases?.title || '';
    const desc = t.description || '';
    const matchesSearch = clientName.toLowerCase().includes(search) || 
                          caseTitle.toLowerCase().includes(search) || 
                          desc.toLowerCase().includes(search);
                          
    const matchesCash = !cashType || t.cash_type === cashType;
    const matchesMove = !moveType || t.movement_type === moveType;
    const matchesStatus = !status || t.status === status;

    return matchesSearch && matchesCash && matchesMove && matchesStatus;
  });

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="table-card">
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
          <p>Nenhum lançamento financeiro encontrado.</p>
        </div>
      </div>`;
    return;
  }

  // Agrupa lançamentos por ID de cliente
  const groups = {};
  filtered.forEach(t => {
    const clientId = t.client_id || 'geral';
    const clientName = t.clients?.name || 'Lançamentos Gerais (Sem Cliente)';
    if (!groups[clientId]) {
      groups[clientId] = {
        name: clientName,
        transactions: []
      };
    }
    groups[clientId].transactions.push(t);
  });

  // Ordena os grupos (deixando Geral/Sem Cliente por último e os outros em ordem alfabética)
  const sortedGroupIds = Object.keys(groups).sort((a, b) => {
    if (a === 'geral') return 1;
    if (b === 'geral') return -1;
    return groups[a].name.localeCompare(groups[b].name);
  });

  // Garante que o estado dos colapsados exista
  if (!AppState.collapsedClients) {
    AppState.collapsedClients = {};
  }

  let htmlContent = '';
  sortedGroupIds.forEach(groupId => {
    const group = groups[groupId];
    const isCollapsed = AppState.collapsedClients[groupId] || false;
    
    // Ícone de seta dependendo de estar colapsado ou não
    const toggleIcon = isCollapsed 
      ? `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" style="vertical-align: middle;"><path d="M9 5l7 7-7 7"/></svg>` // Seta para direita
      : `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" style="vertical-align: middle;"><path d="M19 9l-7 7-7-7"/></svg>`; // Seta para baixo

    const displayStyle = isCollapsed ? 'display: none;' : '';
    
    // Header clicável para colapsar/expandir
    htmlContent += `
      <div class="table-card" style="margin-bottom: 24px;">
        <div class="client-block-header" onclick="toggleClientBlock('${groupId}')" style="background: #F7F5F0; padding: 14px 20px; border-bottom: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center; cursor: pointer; user-select: none;">
          <h3 style="margin: 0; font-size: 0.95rem; font-weight: 800; color: var(--primary); letter-spacing: -0.3px; display: flex; align-items: center; gap: 8px;">
            <span style="color: var(--text-muted); display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 4px; background: #edeae1;">${toggleIcon}</span>
            <span style="color: var(--text-muted); font-weight: 500;">Cliente:</span> ${group.name}
          </h3>
          <span class="badge badge-operacional" style="font-size: 0.7rem; font-weight: 700; background: var(--primary-light); color: var(--primary);">${group.transactions.length} Lançamento(s)</span>
        </div>
        <div class="table-responsive" style="${displayStyle}">
          <table>
            <thead>
              <tr>
                <th style="width: 120px;">Data Venc.</th>
                <th>Descrição / Categoria</th>
                <th>Tipo de Caixa</th>
                <th>Movimento</th>
                <th>Processo / Caso</th>
                <th style="width: 140px;">Valor / Retido</th>
                <th style="width: 100px;">Status</th>
                <th style="width: 100px;">Ações</th>
              </tr>
            </thead>
            <tbody>`;

    group.transactions.forEach(t => {
      // Badges
      const badgeStatus = `<span class="badge badge-${t.status}">${t.status}</span>`;
      const badgeCash = `<span class="badge badge-${t.cash_type}">${t.cash_type === 'operacional' ? 'operacional' : 'transitório'}</span>`;
      const badgeMove = `<span class="badge badge-${t.movement_type}">${t.movement_type}</span>`;
      
      // Detalhes do Caso
      const caseText = t.cases?.title 
        ? `<strong>Pr:</strong> ${t.cases.title} <small class="text-muted">(${t.cases.case_number || 'N/A'})</small>` 
        : '<span class="text-muted">Sem caso associado</span>';

      // Valores
      const valBruto = formatCurrency(parseFloat(t.amount));
      const valRetido = parseFloat(t.tax_withheld_amount) > 0 
        ? `<br><small class="text-muted">Retido: ${formatCurrency(parseFloat(t.tax_withheld_amount))}</small>` 
        : '';

      // Categorias
      const categoryLabels = {
        'honorario_recorrente': 'Honorário Recorrente',
        'honorario_exito': 'Honorário de Êxito',
        'custa_judicial': 'Custa Judicial',
        'reembolso': 'Reembolso',
        'despesa_administrativa': 'Despesa Administrativa',
        'imposto': 'Imposto'
      };
      const catLabel = categoryLabels[t.category] || t.category;

      htmlContent += `
        <tr>
          <td>${formatDate(t.due_date)}</td>
          <td>
            <strong>${t.description || ''}</strong>
            <br><small class="text-muted">${catLabel}</small>
          </td>
          <td>${badgeCash}</td>
          <td>${badgeMove}</td>
          <td>${caseText}</td>
          <td>
            <strong>${valBruto}</strong>
            ${valRetido}
          </td>
          <td>${badgeStatus}</td>
          <td>
            <div class="row-actions">
              ${hasPermission('edit') ? `<button class="btn-icon edit" onclick="openTransactionForm('${t.id}')">
                <svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </button>` : ''}
              ${hasPermission('delete') ? `<button class="btn-icon delete" onclick="handleDeleteTransaction('${t.id}')">
                <svg viewBox="0 0 24 24"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              </button>` : ''}
            </div>
          </td>
        </tr>`;
    });

    htmlContent += `
            </tbody>
          </table>
        </div>
      </div>`;
  });

  container.innerHTML = htmlContent;
}

/**
 * Alterna a visualização (colapso/expansão) de um bloco de cliente específico
 */
window.toggleClientBlock = function(groupId) {
  if (!AppState.collapsedClients) {
    AppState.collapsedClients = {};
  }
  AppState.collapsedClients[groupId] = !AppState.collapsedClients[groupId];
  renderTransactionsTable();
};

// =========================================================================
// RENDERIZAÇÃO: TABELA DE CLIENTES
// =========================================================================
function renderClientsTable() {
  const tbody = document.getElementById('clientsTableBody');
  tbody.innerHTML = '';

  const search = document.getElementById('searchClient').value.toLowerCase();
  
  const filtered = AppState.clients.filter(c => 
    c.name.toLowerCase().includes(search) || 
    (c.document && c.document.includes(search)) || 
    (c.email && c.email.toLowerCase().includes(search))
  );

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6">
          <div class="empty-state">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
            <p>Nenhum cliente cadastrado.</p>
          </div>
        </td>
      </tr>`;
    return;
  }

  filtered.forEach(c => {
    const tr = document.createElement('tr');
    const badgeActive = c.is_active ? '<span class="badge badge-pago">ativo</span>' : '<span class="badge badge-cancelado">inativo</span>';
    
    tr.innerHTML = `
      <td><strong>${c.name}</strong></td>
      <td>${c.document || '---'}</td>
      <td>${c.email || '---'}</td>
      <td>${c.phone || '---'}</td>
      <td>${badgeActive}</td>
      <td>
        <div class="row-actions">
          <button class="btn-icon" onclick="openClientDocChecklistModal('${c.id}')" title="Checklist de Documentos" style="color: #b89764; margin-right: 4px;">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle;">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
              <path d="M12 11v6M9 14h6"></path>
            </svg>
          </button>
          ${hasPermission('edit') ? `<button class="btn-icon edit" onclick="openClientForm('${c.id}')">
            <svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>` : ''}
          ${hasPermission('delete') ? `<button class="btn-icon delete" onclick="handleDeleteClient('${c.id}')">
            <svg viewBox="0 0 24 24"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>` : ''}
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// =========================================================================
// RENDERIZAÇÃO: TABELA DE CASOS / PROCESSOS
// =========================================================================
function renderCasesTable() {
  const tbody = document.getElementById('casesTableBody');
  tbody.innerHTML = '';

  const search = document.getElementById('searchCase').value.toLowerCase();
  
  const filtered = AppState.cases.filter(c => 
    c.title.toLowerCase().includes(search) || 
    (c.case_number && c.case_number.includes(search)) || 
    (c.clients?.name && c.clients.name.toLowerCase().includes(search))
  );

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8">
          <div class="empty-state">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>
            <p>Nenhum caso ou processo cadastrado.</p>
          </div>
        </td>
      </tr>`;
    return;
  }

  filtered.forEach(c => {
    const tr = document.createElement('tr');
    const badgeStatus = `<span class="badge badge-${c.status}">${c.status}</span>`;
    
    const clientName = c.clients?.name || '<span class="text-danger">Desconhecido</span>';
    const originName = c.originating?.full_name || '---';
    const respName = c.responsible?.full_name || '---';

    tr.innerHTML = `
      <td><strong>${c.case_number || 'Fase de Consulta'}</strong></td>
      <td>${c.title}</td>
      <td>${clientName}</td>
      <td>${originName}</td>
      <td>${respName}</td>
      <td>${badgeStatus}</td>
      <td>
        ${hasPermission('splits') ? `<button class="btn btn-secondary" onclick="openSplitRulesModal('${c.id}')" style="padding: 4px 8px; font-size: 0.75rem;">⚙️ Configurar Rateio</button>` : '<span class="text-muted" style="font-size:0.75rem;">Sem acesso</span>'}
      </td>
      <td>
        <div class="row-actions">
          <button class="btn-icon" onclick="openCaseAIModal('${c.id}')" title="Doutor IA Explica" style="color: var(--primary); margin-right: 4px;">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle;">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
              <circle cx="9" cy="9" r="1.2" fill="currentColor"></circle>
              <circle cx="15" cy="9" r="1.2" fill="currentColor"></circle>
            </svg>
          </button>
          <button class="btn-icon" onclick="openLegalDraftModal('${c.id}')" title="Redigir Documento com IA" style="color: var(--info); margin-right: 4px;">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle;">
              <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
            </svg>
          </button>
          ${hasPermission('edit') ? `<button class="btn-icon edit" onclick="openCaseForm('${c.id}')">
            <svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>` : ''}
          ${hasPermission('delete') ? `<button class="btn-icon delete" onclick="handleDeleteCase('${c.id}')">
            <svg viewBox="0 0 24 24"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>` : ''}
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// =========================================================================
// RENDERIZAÇÃO: TABELA DE TIMESHEETS (REGISTROS DE HORAS)
// =========================================================================
function renderTimesheetsTable() {
  const tbody = document.getElementById('timesheetsTableBody');
  tbody.innerHTML = '';

  const search = document.getElementById('searchTimesheet').value.toLowerCase();
  
  const filtered = AppState.timesheets.filter(t => {
    // Associate (e papéis sem view_all_timesheets) só enxergam os próprios registros
    if (!hasPermission('view_all_timesheets') && t.user_profile_id !== AppState.userProfile?.id) {
      return false;
    }
    return (t.description || '').toLowerCase().includes(search) ||
      (t.cases?.title && t.cases.title.toLowerCase().includes(search)) ||
      (t.user_profiles?.full_name && t.user_profiles.full_name.toLowerCase().includes(search));
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="9">
          <div class="empty-state">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2z"/></svg>
            <p>Nenhum registro de horas trabalhado.</p>
          </div>
        </td>
      </tr>`;
    return;
  }

  filtered.forEach(t => {
    const tr = document.createElement('tr');
    
    const advName = t.user_profiles?.full_name || '---';
    const caseTitle = t.cases?.title || '<span class="text-danger">Desconhecido</span>';
    const isBillableBadge = t.is_billable ? '<span class="badge badge-pago">Sim</span>' : '<span class="badge badge-cancelado">Não</span>';

    // Permissão por linha: owner/partner editam todos; associate edita só os próprios
    const isOwn = t.user_profile_id === AppState.userProfile?.id;
    const canEditThis  = hasPermission('edit') || (hasPermission('edit_own_timesheets') && isOwn);
    const canDeleteThis = hasPermission('delete') || (hasPermission('edit_own_timesheets') && isOwn);

    tr.innerHTML = `
      <td>${formatDate(t.work_date)}</td>
      <td>${advName}</td>
      <td>${caseTitle}</td>
      <td>${t.description || ''}</td>
      <td>${parseFloat(t.hours).toFixed(1)}h</td>
      <td>${formatCurrency(parseFloat(t.hourly_rate))}</td>
      <td><strong>${formatCurrency(parseFloat(t.billed_amount))}</strong></td>
      <td>${isBillableBadge}</td>
      <td>
        <div class="row-actions">
          ${canEditThis ? `<button class="btn-icon edit" onclick="openTimesheetForm('${t.id}')">
            <svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>` : ''}
          ${canDeleteThis ? `<button class="btn-icon delete" onclick="handleDeleteTimesheet('${t.id}')">
            <svg viewBox="0 0 24 24"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>` : ''}
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// =========================================================================
// RENDERIZAÇÃO: EQUIPE E MEMBROS
// =========================================================================
function renderMembersTable() {
  const tbody = document.getElementById('membersTableBody');
  tbody.innerHTML = '';

  if (AppState.members.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6">
          <div class="empty-state">
            <p>Nenhum membro da equipe localizado.</p>
          </div>
        </td>
      </tr>`;
    return;
  }

  AppState.members.forEach(m => {
    const tr = document.createElement('tr');
    const statusBadge = m.is_active ? '<span class="badge badge-pago">ativo</span>' : '<span class="badge badge-cancelado">inativo</span>';
    
    // Mapeia labels de cargo
    const roleLabels = {
      'owner': 'Proprietário (Dono)',
      'partner': 'Sócio',
      'associate': 'Advogado Parceiro',
      'financial': 'Assessor Jurídico',
      'secretary': 'Secretária'
    };

    tr.innerHTML = `
      <td><strong>${m.full_name}</strong></td>
      <td>${m.email}</td>
      <td><span class="badge badge-operacional">${roleLabels[m.role] || m.role}</span></td>
      <td>${m.default_hourly_rate ? formatCurrency(parseFloat(m.default_hourly_rate)) : 'Não configurada'}</td>
      <td>${statusBadge}</td>
      <td>
        <div class="row-actions">
          <button class="btn-icon edit" onclick="openMemberForm('${m.id}')" title="Editar Perfil">
            <svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          ${(AppState.userProfile && AppState.userProfile.role === 'owner' && m.id !== AppState.userProfile.id) ? `
          <button class="btn-icon delete" onclick="handleDeleteMember('${m.id}')" title="Remover Membro">
            <svg viewBox="0 0 24 24"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>` : ''}
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}



// =========================================================================
// GESTÃO DE MODAIS E SUBMISSÃO DE FORMULÁRIOS
// =========================================================================

/**
 * CLIENTES (Inserção / Edição)
 */
function openClientForm(clientId = null) {
  const overlay = document.getElementById('clientModalOverlay');
  const title = document.getElementById('clientModalTitle');
  const idInput = document.getElementById('clientIdInput');
  const nameInput = document.getElementById('clientNameInput');
  const docInput = document.getElementById('clientDocInput');
  const emailInput = document.getElementById('clientEmailInput');
  const phoneInput = document.getElementById('clientPhoneInput');
  const activeInput = document.getElementById('clientActiveInput');

  // Limpa o formulário
  document.getElementById('clientForm').reset();
  idInput.value = '';

  if (clientId) {
    title.textContent = "Editar Cliente";
    const client = AppState.clients.find(c => c.id === clientId);
    if (client) {
      idInput.value = client.id;
      nameInput.value = client.name;
      docInput.value = client.document || '';
      emailInput.value = client.email || '';
      phoneInput.value = client.phone || '';
      activeInput.value = client.is_active ? "true" : "false";
    }
  } else {
    title.textContent = "Cadastrar Cliente";
    activeInput.value = "true";
  }

  overlay.classList.add('active');
}

async function handleClientFormSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('clientIdInput').value;
  const payload = {
    name: document.getElementById('clientNameInput').value,
    document: document.getElementById('clientDocInput').value || null,
    email: document.getElementById('clientEmailInput').value || null,
    phone: document.getElementById('clientPhoneInput').value || null,
    is_active: document.getElementById('clientActiveInput').value === "true"
  };

  const tenantId = getEffectiveTenantId();
  if (!tenantId) {
    showToast("Erro: Identificador do escritório não encontrado. Faça login novamente.", "error");
    return;
  }

  showLoader(true);
  try {
    if (id) {
      const updated = await updateClient(id, payload);
      if (updated) {
        const idx = AppState.clients.findIndex(c => c.id === id);
        if (idx !== -1) {
          AppState.clients[idx] = { ...AppState.clients[idx], ...updated };
        }
      }
      showToast("Cliente atualizado com sucesso!", "success");
    } else {
      const created = await createClient(tenantId, payload);
      if (created) {
        AppState.clients.push(created);
      }
      showToast("Cliente criado com sucesso!", "success");
    }
    
    // Atualiza tabela imediatamente
    renderClientsTable();
    // Fecha o modal imediatamente
    closeModal('clientModalOverlay');

    // Sincroniza em background
    refreshAllData().then(() => {
      renderClientsTable();
    }).catch(console.error);

  } catch (err) {
    showToast("Erro ao salvar cliente: " + err.message, "error");
  } finally {
    showLoader(false);
  }
}

async function handleDeleteClient(clientId) {
  if (!confirm("Deseja realmente remover este cliente? Isso pode falhar se existirem processos atrelados.")) return;
  
  showLoader(true);
  try {
    await deleteClient(clientId);
    showToast("Cliente removido com sucesso.", "success");
    await refreshAllData();
    renderClientsTable();
  } catch (err) {
    showToast("Erro ao remover: " + err.message, "error");
  } finally {
    showLoader(false);
  }
}

/**
 * CASOS / PROCESSOS (Inserção / Edição)
 */
function openCaseForm(caseId = null) {
  const overlay = document.getElementById('caseModalOverlay');
  const title = document.getElementById('caseModalTitle');
  
  const idInput = document.getElementById('caseIdInput');
  const clientSelect = document.getElementById('caseClientSelect');
  const titleInput = document.getElementById('caseTitleInput');
  const numberInput = document.getElementById('caseNumberInput');
  const originatingSelect = document.getElementById('caseOriginatingSelect');
  const responsibleSelect = document.getElementById('caseResponsibleSelect');
  const statusSelect = document.getElementById('caseStatusSelect');

  // Popula selects dinamicamente
  populateSelect(clientSelect, AppState.clients.filter(c => c.is_active), 'id', 'name', 'Selecione o Cliente...');
  
  // Filtra advogados (sócios, owners e associados)
  let membersList = [...(AppState.members || [])];
  if (AppState.userProfile && !membersList.some(m => m.id === AppState.userProfile.id)) {
    membersList.push(AppState.userProfile);
  }
  const lawyers = membersList.filter(m => m.is_active !== false && m.role !== 'financial');
  populateSelect(originatingSelect, lawyers, 'id', 'full_name', 'Nenhum (Sem Originação)');
  populateSelect(responsibleSelect, lawyers, 'id', 'full_name', 'Nenhum (Sem Responsável)');

  document.getElementById('caseForm').reset();
  idInput.value = '';

  if (caseId) {
    title.textContent = "Editar Processo / Caso";
    const c = AppState.cases.find(item => item.id === caseId);
    if (c) {
      idInput.value = c.id;
      clientSelect.value = c.client_id;
      titleInput.value = c.title;
      numberInput.value = c.case_number || '';
      originatingSelect.value = c.originating_partner_id || '';
      responsibleSelect.value = c.responsible_partner_id || '';
      statusSelect.value = c.status;
    }
  } else {
    title.textContent = "Novo Processo / Caso";
    statusSelect.value = 'ativo';
  }

  overlay.classList.add('active');
}

async function handleCaseFormSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('caseIdInput').value;
  const payload = {
    client_id: document.getElementById('caseClientSelect').value,
    title: document.getElementById('caseTitleInput').value,
    case_number: document.getElementById('caseNumberInput').value || null,
    originating_partner_id: document.getElementById('caseOriginatingSelect').value || null,
    responsible_partner_id: document.getElementById('caseResponsibleSelect').value || null,
    status: document.getElementById('caseStatusSelect').value
  };

  const tenantId = getEffectiveTenantId();
  if (!tenantId) {
    showToast("Erro: Identificador do escritório não encontrado. Faça login novamente.", "error");
    return;
  }

  showLoader(true);
  try {
    if (id) {
      const updated = await updateCase(id, payload);
      if (updated) {
        const idx = AppState.cases.findIndex(c => c.id === id);
        if (idx !== -1) {
          AppState.cases[idx] = { ...AppState.cases[idx], ...updated };
        }
      }
      showToast("Processo atualizado com sucesso!", "success");
    } else {
      const created = await createCase(tenantId, payload);
      if (created) {
        const cl = AppState.clients.find(c => c.id === created.client_id);
        created.clients = cl ? { name: cl.name } : null;
        
        const orig = AppState.members.find(m => m.id === created.originating_partner_id);
        created.originating = orig ? { full_name: orig.full_name } : null;

        const resp = AppState.members.find(m => m.id === created.responsible_partner_id);
        created.responsible = resp ? { full_name: resp.full_name } : null;

        AppState.cases.push(created);
      }
      showToast("Processo criado com sucesso!", "success");
    }
    
    // Atualiza tabela imediatamente
    renderCasesTable();
    // Fecha o modal imediatamente
    closeModal('caseModalOverlay');

    // Sincroniza em background
    refreshAllData().then(() => {
      renderCasesTable();
    }).catch(console.error);

  } catch (err) {
    showToast("Erro ao salvar processo: " + err.message, "error");
  } finally {
    showLoader(false);
  }
}

async function handleDeleteCase(caseId) {
  if (!confirm("Remover este caso apagará históricos financeiros vinculados. Confirmar exclusão?")) return;
  showLoader(true);
  try {
    await deleteCase(caseId);
    showToast("Caso removido com sucesso.", "success");
    await refreshAllData();
    renderCasesTable();
  } catch (err) {
    showToast("Erro ao deletar: " + err.message, "error");
  } finally {
    showLoader(false);
  }
}

function addMonths(dateStr, months) {
  const parts = dateStr.split('-');
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1;
  const day = parseInt(parts[2], 10);
  const date = new Date(year, month + months, day);
  
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * TRANSAÇÕES / LANÇAMENTOS (Inserção / Edição)
 */
function openTransactionForm(transId = null) {
  const overlay = document.getElementById('transModalOverlay');
  const title = document.getElementById('transModalTitle');
  
  const idInput = document.getElementById('transIdInput');
  const cashTypeSelect = document.getElementById('transCashTypeSelect');
  const movementSelect = document.getElementById('transMovementSelect');
  const categorySelect = document.getElementById('transCategorySelect');
  const statusSelect = document.getElementById('transStatusSelect');
  
  const amountInput = document.getElementById('transAmountInput');
  const taxInput = document.getElementById('transTaxInput');
  const dueDateInput = document.getElementById('transDueDateInput');
  const paidAtInput = document.getElementById('transPaidAtInput');
  
  const clientSelect = document.getElementById('transClientSelect');
  const caseSelect = document.getElementById('transCaseSelect');
  const descInput = document.getElementById('transDescInput');

  const installmentsRow = document.getElementById('transInstallmentsRow');
  const installmentsInput = document.getElementById('transInstallmentsInput');
  const paymentMethodSelect = document.getElementById('transPaymentMethodSelect');

  // Popula selects de clientes e casos
  populateSelect(clientSelect, AppState.clients, 'id', 'name', 'Nenhum Cliente');
  populateSelect(caseSelect, AppState.cases, 'id', 'title', 'Nenhum Caso');

  document.getElementById('transForm').reset();
  idInput.value = '';
  document.getElementById('transCaseAlert').style.display = 'none';

  if (transId) {
    title.textContent = "Editar Lançamento";
    installmentsRow.style.display = 'none'; // Oculta opções de parcelamento na edição
    installmentsInput.value = '1';
    
    const t = AppState.transactions.find(item => item.id === transId);
    if (t) {
      idInput.value = t.id;
      cashTypeSelect.value = t.cash_type;
      movementSelect.value = t.movement_type;
      categorySelect.value = t.category;
      statusSelect.value = t.status;
      amountInput.value = parseFloat(t.amount);
      taxInput.value = parseFloat(t.tax_withheld_amount);
      dueDateInput.value = t.due_date;
      paidAtInput.value = t.paid_at ? t.paid_at.substring(0, 16) : '';
      clientSelect.value = t.client_id || '';
      caseSelect.value = t.case_id || '';
      descInput.value = t.description || '';
      
      toggleTransactionFormFields();
    }
  } else {
    title.textContent = "Novo Lançamento";
    installmentsRow.style.display = 'flex'; // Exibe opções de parcelamento para novos lançamentos
    installmentsInput.value = '1';
    paymentMethodSelect.value = 'Pix';
    
    statusSelect.value = 'pendente';
    cashTypeSelect.value = 'operacional';
    movementSelect.value = 'receita';
    categorySelect.value = 'honorario_recorrente';
    taxInput.value = '0.00';
    dueDateInput.value = new Date().toISOString().split('T')[0];
    
    toggleTransactionFormFields();
  }

  overlay.classList.add('active');
}

/**
 * Controla a visibilidade e obrigatoriedade dos campos baseado na regra
 * contábil: transitorio_terceiros exige caso específico
 */
function toggleTransactionFormFields() {
  const cashType = document.getElementById('transCashTypeSelect').value;
  const alertEl = document.getElementById('transCaseAlert');
  const labelEl = document.getElementById('transCaseLabel');
  
  if (cashType === 'transitorio_terceiros') {
    labelEl.classList.add('required');
    alertEl.style.display = 'block';
  } else {
    labelEl.classList.remove('required');
    alertEl.style.display = 'none';
  }
}

async function handleTransFormSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('transIdInput').value;
  
  const cashType = document.getElementById('transCashTypeSelect').value;
  const caseId = document.getElementById('transCaseSelect').value || null;

  // Validação frontend complementar à constraint do DB
  if (cashType === 'transitorio_terceiros' && !caseId) {
    showToast("Dinheiro transitório de terceiros exige vínculo com Processo/Caso contábil.", "error");
    document.getElementById('transCaseSelect').focus();
    return;
  }

  const installments = parseInt(document.getElementById('transInstallmentsInput').value) || 1;
  const paymentMethod = document.getElementById('transPaymentMethodSelect').value;

  const baseAmount = parseFloat(document.getElementById('transAmountInput').value);
  const baseTax = parseFloat(document.getElementById('transTaxInput').value) || 0;
  const baseDueDate = document.getElementById('transDueDateInput').value;
  const basePaidAt = document.getElementById('transPaidAtInput').value;
  const baseDesc = document.getElementById('transDescInput').value || 'Lançamento';
  const client_id = document.getElementById('transClientSelect').value || null;

  showLoader(true);
  try {
    if (id) {
      // Edição simples
      const payload = {
        cash_type: cashType,
        movement_type: document.getElementById('transMovementSelect').value,
        category: document.getElementById('transCategorySelect').value,
        status: document.getElementById('transStatusSelect').value,
        amount: baseAmount,
        tax_withheld_amount: baseTax,
        due_date: baseDueDate,
        paid_at: basePaidAt ? new Date(basePaidAt).toISOString() : null,
        client_id: client_id,
        case_id: caseId,
        description: baseDesc
      };
      await updateTransaction(id, payload);
      showToast("Lançamento atualizado com sucesso!", "success");
    } else {
      // Criação de novos lançamentos (único ou parcelado)
      if (installments > 1) {
        const payloadArray = [];
        
        // Divisão de valores e impostos centavos-a-centavos
        const amountPerInstallment = parseFloat((baseAmount / installments).toFixed(2));
        const taxPerInstallment = parseFloat((baseTax / installments).toFixed(2));
        
        const amountDiff = parseFloat((baseAmount - (amountPerInstallment * installments)).toFixed(2));
        const taxDiff = parseFloat((baseTax - (taxPerInstallment * installments)).toFixed(2));
        
        for (let i = 0; i < installments; i++) {
          const instAmount = amountPerInstallment + (i === installments - 1 ? amountDiff : 0);
          const instTax = taxPerInstallment + (i === installments - 1 ? taxDiff : 0);
          const instDueDate = addMonths(baseDueDate, i);
          
          // Prepara descrição identificando a parcela e forma de pagamento
          const instDesc = `[${paymentMethod}] ${baseDesc} (Parcela ${i + 1}/${installments})`;
          
          // Se status for 'pago', apenas a 1ª parcela é dada como paga (as outras ficam 'pendente' e sem data_pagamento)
          const statusVal = document.getElementById('transStatusSelect').value;
          const instStatus = (i === 0) ? statusVal : 'pendente';
          const instPaidAt = (i === 0 && statusVal === 'pago' && basePaidAt) ? new Date(basePaidAt).toISOString() : null;

          payloadArray.push({
            tenant_id: AppState.userProfile.tenant_id,
            recorded_by: AppState.userProfile.id,
            cash_type: cashType,
            movement_type: document.getElementById('transMovementSelect').value,
            category: document.getElementById('transCategorySelect').value,
            status: instStatus,
            amount: instAmount,
            tax_withheld_amount: instTax,
            due_date: instDueDate,
            paid_at: instPaidAt,
            client_id: client_id,
            case_id: caseId,
            description: instDesc
          });
        }
        
        await createTransactionsBulk(payloadArray);
        showToast(`${installments} parcelas cadastradas com sucesso!`, "success");
      } else {
        // Lançamento único simples
        const instDesc = `[${paymentMethod}] ${baseDesc}`;
        const payload = {
          cash_type: cashType,
          movement_type: document.getElementById('transMovementSelect').value,
          category: document.getElementById('transCategorySelect').value,
          status: document.getElementById('transStatusSelect').value,
          amount: baseAmount,
          tax_withheld_amount: baseTax,
          due_date: baseDueDate,
          paid_at: basePaidAt ? new Date(basePaidAt).toISOString() : null,
          client_id: client_id,
          case_id: caseId,
          description: instDesc
        };
        await createTransaction(
          AppState.userProfile.tenant_id,
          AppState.userProfile.id,
          payload
        );
        showToast("Lançamento cadastrado com sucesso!", "success");
      }
    }
    await refreshAllData();
    renderTransactionsTable();
    closeModal('transModalOverlay');
  } catch (err) {
    showToast("Erro ao registrar lançamento: " + err.message, "error");
  } finally {
    showLoader(false);
  }
}

async function handleDeleteTransaction(transId) {
  if (!confirm("Tem certeza que deseja excluir esta transação? Essa operação é irreversível.")) return;
  showLoader(true);
  try {
    await deleteTransaction(transId);
    showToast("Lançamento removido com sucesso.", "success");
    await refreshAllData();
    renderTransactionsTable();
  } catch (err) {
    showToast("Erro ao remover: " + err.message, "error");
  } finally {
    showLoader(false);
  }
}

/**
 * TIMESHEETS (Lançamento de horas)
 */
function openTimesheetForm(timesheetId = null) {
  const overlay = document.getElementById('timesheetModalOverlay');
  const title = document.getElementById('timesheetModalTitle');
  
  const idInput = document.getElementById('timesheetIdInput');
  const caseSelect = document.getElementById('timesheetCaseSelect');
  const dateInput = document.getElementById('timesheetDateInput');
  const billableSelect = document.getElementById('timesheetBillableSelect');
  const hoursInput = document.getElementById('timesheetHoursInput');
  const rateInput = document.getElementById('timesheetRateInput');
  const descInput = document.getElementById('timesheetDescInput');

  // Popula casos
  populateSelect(caseSelect, AppState.cases.filter(c => c.status === 'ativo'), 'id', 'title', 'Selecione o Caso/Processo...');

  document.getElementById('timesheetForm').reset();
  idInput.value = '';

  if (timesheetId) {
    title.textContent = "Editar Registro de Horas";
    const t = AppState.timesheets.find(item => item.id === timesheetId);
    if (t) {
      idInput.value = t.id;
      caseSelect.value = t.case_id;
      dateInput.value = t.work_date;
      billableSelect.value = t.is_billable ? "true" : "false";
      hoursInput.value = parseFloat(t.hours);
      rateInput.value = parseFloat(t.hourly_rate);
      descInput.value = t.description || '';
    }
  } else {
    title.textContent = "Registrar Horas Trabalhadas";
    dateInput.value = new Date().toISOString().split('T')[0];
    billableSelect.value = "true";
    // Carrega taxa padrão do usuário
    rateInput.value = AppState.userProfile.default_hourly_rate ? parseFloat(AppState.userProfile.default_hourly_rate) : 150.00;
  }

  updateTimesheetSubtotal();
  overlay.classList.add('active');
}

function updateTimesheetSubtotal() {
  const hours = parseFloat(document.getElementById('timesheetHoursInput').value) || 0;
  const rate = parseFloat(document.getElementById('timesheetRateInput').value) || 0;
  const subtotal = hours * rate;
  document.getElementById('timesheetSubtotalView').textContent = formatCurrency(subtotal);
}

async function handleTimesheetFormSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('timesheetIdInput').value;
  const payload = {
    user_profile_id: AppState.userProfile.id,
    case_id: document.getElementById('timesheetCaseSelect').value,
    work_date: document.getElementById('timesheetDateInput').value,
    hours: parseFloat(document.getElementById('timesheetHoursInput').value),
    hourly_rate: parseFloat(document.getElementById('timesheetRateInput').value),
    is_billable: document.getElementById('timesheetBillableSelect').value === "true",
    description: document.getElementById('timesheetDescInput').value
  };

  showLoader(true);
  try {
    if (id) {
      await updateTimesheet(id, payload);
      showToast("Registro atualizado com sucesso!", "success");
    } else {
      await createTimesheet(AppState.userProfile.tenant_id, payload);
      showToast("Horas registradas com sucesso!", "success");
    }
    await refreshAllData();
    renderTimesheetsTable();
    closeModal('timesheetModalOverlay');
  } catch (err) {
    showToast("Erro ao registrar horas: " + err.message, "error");
  } finally {
    showLoader(false);
  }
}

async function handleDeleteTimesheet(sheetId) {
  if (!confirm("Remover este lançamento do timesheet?")) return;
  showLoader(true);
  try {
    await deleteTimesheet(sheetId);
    showToast("Horas removidas com sucesso.", "success");
    await refreshAllData();
    renderTimesheetsTable();
  } catch (err) {
    showToast("Erro ao excluir: " + err.message, "error");
  } finally {
    showLoader(false);
  }
}

/**
 * REGRAS DE RATEIO / SPLITS (Edição em lote por caso)
 */
async function openSplitRulesModal(caseId) {
  AppState.currentSplitCaseId = caseId;
  const currentCase = AppState.cases.find(c => c.id === caseId);
  
  document.getElementById('splitModalSubtitle').textContent = `Processo: ${currentCase.title} (${currentCase.case_number || 'Sem CNJ'})`;
  
  const container = document.getElementById('splitRulesRowsContainer');
  container.innerHTML = '';
  
  showLoader(true);
  try {
    const rules = await getSplitRules(caseId);
    if (rules.length === 0) {
      // Inicia com uma linha default de caixa do escritório se não houver regras
      addSplitRuleRow({ split_role: 'caixa_escritorio', percentage: 100, user_profile_id: '' });
    } else {
      rules.forEach(rule => {
        addSplitRuleRow({
          split_role: rule.split_role,
          percentage: parseFloat(rule.percentage),
          user_profile_id: rule.user_profile_id || ''
        });
      });
    }
    calculateSplitsSum();
    document.getElementById('splitModalOverlay').classList.add('active');
  } catch (err) {
    showToast("Erro ao obter regras de rateio: " + err.message, "error");
  } finally {
    showLoader(false);
  }
}

/**
 * Cria dinamicamente elementos de input para regras de splits
 */
function addSplitRuleRow(data = { split_role: 'caixa_escritorio', percentage: 10, user_profile_id: '' }) {
  const container = document.getElementById('splitRulesRowsContainer');
  const div = document.createElement('div');
  div.className = 'split-rule-row';
  
  // Select de colaboradores + opção Escritório
  const lawyers = AppState.members.filter(m => m.is_active);
  let userOptions = `<option value="">-- Escritório (Caixa Geral) --</option>`;
  lawyers.forEach(l => {
    const selected = l.id === data.user_profile_id ? 'selected' : '';
    userOptions += `<option value="${l.id}" ${selected}>${l.full_name} (${l.role})</option>`;
  });

  const roles = [
    { val: 'caixa_escritorio', label: 'Caixa Escritório' },
    { val: 'originador', label: 'Sócio Originador' },
    { val: 'executor', label: 'Advogado Executor' },
    { val: 'outro_socio', label: 'Outro Sócio' }
  ];
  let roleOptions = '';
  roles.forEach(r => {
    const selected = r.val === data.split_role ? 'selected' : '';
    roleOptions += `<option value="${r.val}" ${selected}>${r.label}</option>`;
  });

  div.innerHTML = `
    <select class="form-control split-user-select" onchange="handleSplitUserChange(this)">
      ${userOptions}
    </select>
    
    <select class="form-control split-role-select">
      ${roleOptions}
    </select>
    
    <div class="percentage-input-wrapper">
      <input type="number" step="0.5" min="0.1" max="100" class="form-control split-percent-input" value="${data.percentage}" oninput="calculateSplitsSum()">
    </div>
    
    <button type="button" class="btn-icon delete" onclick="this.parentElement.remove(); calculateSplitsSum();">
      <svg viewBox="0 0 24 24"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
    </button>
  `;
  
  container.appendChild(div);
}

/**
 * Se selecionar um usuário, muda o papel para algo diferente de caixa_escritorio
 */
function handleSplitUserChange(selectEl) {
  const row = selectEl.parentElement;
  const roleSelect = row.querySelector('.split-role-select');
  if (selectEl.value === '') {
    roleSelect.value = 'caixa_escritorio';
  } else if (roleSelect.value === 'caixa_escritorio') {
    roleSelect.value = 'executor'; // default se tiver colaborador selecionado
  }
}

/**
 * Calcula a soma das percentagens configuradas para validação visual
 */
function calculateSplitsSum() {
  const percentInputs = document.querySelectorAll('.split-percent-input');
  let sum = 0;
  percentInputs.forEach(input => {
    sum += parseFloat(input.value) || 0;
  });

  const label = document.getElementById('splitTotalLabel');
  const bar = document.getElementById('splitProgressBarFill');
  const feedback = document.getElementById('splitFeedbackText');

  label.textContent = `${sum.toFixed(2)}% / 100.00%`;
  bar.style.width = `${Math.min(100, sum)}%`;

  if (sum === 100) {
    bar.className = 'split-progress-fill valid';
    feedback.innerHTML = '<span style="color: var(--success);">✔️ Rateio configurado corretamente! Totaliza 100%.</span>';
    document.getElementById('btnSaveSplitRules').disabled = false;
  } else {
    document.getElementById('btnSaveSplitRules').disabled = true;
    if (sum > 100) {
      bar.className = 'split-progress-fill invalid';
      feedback.innerHTML = `<span style="color: var(--danger);">❌ A soma excede 100% (atual: ${sum.toFixed(2)}%). Reduza os valores.</span>`;
    } else {
      bar.className = 'split-progress-fill warning';
      feedback.innerHTML = `<span style="color: var(--warning);">⚠️ A soma está abaixo de 100% (atual: ${sum.toFixed(2)}%). Falta distribuir ${(100 - sum).toFixed(2)}%.</span>`;
    }
  }
}

async function handleSaveSplitRulesSubmit() {
  const rows = document.querySelectorAll('.split-rule-row');
  const rulesArray = [];
  
  let valid = true;
  rows.forEach(row => {
    const userProfileId = row.querySelector('.split-user-select').value;
    const splitRole = row.querySelector('.split-role-select').value;
    const percentage = parseFloat(row.querySelector('.split-percent-input').value) || 0;
    
    // Validação de compliance do DB:
    // caixa_escritorio -> user_profile_id deve ser null.
    // outros -> user_profile_id não pode ser null.
    if (splitRole === 'caixa_escritorio' && userProfileId !== '') {
      showToast("Fatias destinadas ao 'Caixa Escritório' não devem ter um advogado selecionado.", "error");
      valid = false;
    }
    if (splitRole !== 'caixa_escritorio' && userProfileId === '') {
      showToast("Fatias de comissão exigem a seleção de um advogado correspondente.", "error");
      valid = false;
    }

    rulesArray.push({
      user_profile_id: userProfileId || null,
      split_role: splitRole,
      percentage: percentage
    });
  });

  if (!valid) return;

  showLoader(true);
  try {
    await saveSplitRules(AppState.userProfile.tenant_id, AppState.currentSplitCaseId, rulesArray);
    showToast("Regras de rateio salvas com sucesso!", "success");
    closeModal('splitModalOverlay');
  } catch (err) {
    showToast("Erro ao salvar splits: " + err.message, "error");
  } finally {
    showLoader(false);
  }
}

/**
 * EDITAR PERFIL DE MEMBRO DA EQUIPE
 */
function openMemberForm(profileId) {
  const overlay = document.getElementById('memberModalOverlay');
  const member = AppState.members.find(m => m.id === profileId);
  if (!member) return;

  document.getElementById('memberIdInput').value = member.id;
  document.getElementById('memberNameInput').value = member.full_name;
  document.getElementById('memberRoleSelect').value = member.role;
  document.getElementById('memberHourlyRateInput').value = member.default_hourly_rate ? parseFloat(member.default_hourly_rate) : '';
  document.getElementById('memberActiveSelect').value = member.is_active ? "true" : "false";

  overlay.classList.add('active');
}

async function handleMemberFormSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('memberIdInput').value;
  const payload = {
    role: document.getElementById('memberRoleSelect').value,
    default_hourly_rate: parseFloat(document.getElementById('memberHourlyRateInput').value) || null,
    is_active: document.getElementById('memberActiveSelect').value === "true"
  };

  showLoader(true);
  try {
    await updateUserProfile(id, payload);
    showToast("Membro da equipe atualizado!", "success");
    await refreshAllData();
    renderMembersTable();
    closeModal('memberModalOverlay');
  } catch (err) {
    showToast("Erro ao atualizar perfil: " + err.message, "error");
  } finally {
    showLoader(false);
  }
}

async function handleDeleteMember(profileId) {
  if (!confirm("Deseja realmente excluir este perfil? Esta ação RLS é altamente restritiva.")) return;
  showLoader(true);
  try {
    await deleteUserProfile(profileId);
    showToast("Membro removido com sucesso.", "success");
    await refreshAllData();
    renderMembersTable();
  } catch (err) {
    showToast("Erro ao excluir: " + err.message, "error");
  } finally {
    showLoader(false);
  }
}

// =========================================================================
// ASSINATURAS DE LISTENERS DE FORMULÁRIO (Event Listeners)
// =========================================================================
function _addEvent(id, eventName, handler) {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener(eventName, handler);
  } else {
    console.warn(`Aviso: Elemento com ID "${id}" não encontrado na página para evento "${eventName}".`);
  }
}

function initFormEventListeners() {
  // Login
  _addEvent('loginForm', 'submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;
    
    showLoader(true);
    try {
      const data = await signInUser(email, password);
      showToast("Conexão estabelecida com sucesso!", "success");
      if (data && data.session) {
        localStorage.setItem('advcontrol_session_cache', JSON.stringify(data.session));
      }
      await handleUserAuthenticated(data.session);
    } catch (err) {
      showToast("Falha no login: " + err.message, "error");
    } finally {
      showLoader(false);
    }
  });

  // Cadastro de Novo Usuário (Tenant Creator ou Convidado)
  _addEvent('registerForm', 'submit', async (e) => {
    e.preventDefault();
    const name     = document.getElementById('registerName').value.trim();
    const email    = document.getElementById('registerEmail').value.trim();
    const password = document.getElementById('registerPassword').value;

    const tenantId = _inviteTenantId || null;
    const role     = tenantId ? (_inviteRole || 'associate') : null;

    showLoader(true);
    try {
      const result = await signUpUser(email, password, name, tenantId, role);

      if (tenantId) {
        window.history.replaceState({}, document.title, window.location.pathname);
        _inviteTenantId = null;
        _inviteRole = 'associate';
      }

      if (result && result.session) {
        showToast('Cadastro realizado! Entrando automaticamente...', 'success');
        localStorage.setItem('advcontrol_session_cache', JSON.stringify(result.session));
        await handleUserAuthenticated(result.session);
      } else {
        showToast('Cadastro realizado! Verifique seu e-mail para confirmar a conta.', 'success');
        const rSection = document.getElementById('registerFormSection');
        const lSection = document.getElementById('loginFormSection');
        if (rSection) rSection.style.display = 'none';
        if (lSection) lSection.style.display = 'block';
        const loginEmailEl = document.getElementById('loginEmail');
        if (loginEmailEl) loginEmailEl.value = email;
      }
    } catch (err) {
      showToast('Erro no cadastro: ' + err.message, 'error');
    } finally {
      showLoader(false);
    }
  });

  // CRUD Forms Submits
  _addEvent('clientForm', 'submit', handleClientFormSubmit);
  _addEvent('caseForm', 'submit', handleCaseFormSubmit);
  _addEvent('transForm', 'submit', handleTransFormSubmit);
  _addEvent('timesheetForm', 'submit', handleTimesheetFormSubmit);
  _addEvent('memberForm', 'submit', handleMemberFormSubmit);

  // Botões de cancelamento / fechar modais
  _addEvent('btnCancelClientModal', 'click', () => closeModal('clientModalOverlay'));
  _addEvent('btnCloseClientModal', 'click', () => closeModal('clientModalOverlay'));

  _addEvent('btnCancelCaseModal', 'click', () => closeModal('caseModalOverlay'));
  _addEvent('btnCloseCaseModal', 'click', () => closeModal('caseModalOverlay'));

  _addEvent('btnCancelTransModal', 'click', () => closeModal('transModalOverlay'));
  _addEvent('btnCloseTransModal', 'click', () => closeModal('transModalOverlay'));

  _addEvent('btnCancelTimesheetModal', 'click', () => closeModal('timesheetModalOverlay'));
  _addEvent('btnCloseTimesheetModal', 'click', () => closeModal('timesheetModalOverlay'));

  _addEvent('btnCancelSplitModal', 'click', () => closeModal('splitModalOverlay'));
  _addEvent('btnCloseSplitModal', 'click', () => closeModal('splitModalOverlay'));
  _addEvent('btnSaveSplitRules', 'click', handleSaveSplitRulesSubmit);
  _addEvent('btnAddSplitRuleRow', 'click', () => addSplitRuleRow());

  _addEvent('btnCancelMemberModal', 'click', () => closeModal('memberModalOverlay'));
  _addEvent('btnCloseMemberModal', 'click', () => closeModal('memberModalOverlay'));

  _addEvent('btnCancelClientDocModal', 'click', () => closeModal('clientDocModalOverlay'));
  _addEvent('btnCloseClientDocModal', 'click', () => closeModal('clientDocModalOverlay'));

  // Gatilhos de Abertura de Novo Cadastro
  _addEvent('btnNewClient', 'click', () => openClientForm());
  _addEvent('btnNewCase', 'click', () => openCaseForm());
  _addEvent('btnNewTransaction', 'click', () => openTransactionForm());
  _addEvent('btnNewTimesheet', 'click', () => openTimesheetForm());

  // Input de Taxa do Timesheet atualizado
  _addEvent('timesheetHoursInput', 'input', updateTimesheetSubtotal);
  _addEvent('timesheetRateInput', 'input', updateTimesheetSubtotal);

  // Regra condicional de lançamento de transações
  _addEvent('transCashTypeSelect', 'change', toggleTransactionFormFields);

  // Monitoradores de Filtros
  _addEvent('searchTransaction', 'input', renderTransactionsTable);
  _addEvent('filterCashType', 'change', renderTransactionsTable);
  _addEvent('filterMovementType', 'change', renderTransactionsTable);
  _addEvent('filterStatus', 'change', renderTransactionsTable);
  
  _addEvent('searchClient', 'input', renderClientsTable);
  _addEvent('searchCase', 'input', renderCasesTable);
  _addEvent('searchTimesheet', 'input', renderTimesheetsTable);

  _addEvent('btnSwitchToRegister', 'click', (e) => {
    e.preventDefault();
    const lSection = document.getElementById('loginFormSection');
    const rSection = document.getElementById('registerFormSection');
    if (lSection) lSection.style.display = 'none';
    if (rSection) rSection.style.display = 'block';
  });

  _addEvent('btnSwitchToLogin', 'click', (e) => {
    e.preventDefault();
    const lSection = document.getElementById('loginFormSection');
    const rSection = document.getElementById('registerFormSection');
    if (lSection) lSection.style.display = 'block';
    if (rSection) rSection.style.display = 'none';
  });

  // Botão de Logout
  _addEvent('btnLogout', 'click', async () => {
    try {
      showLoader(true);
      await signOutUser();
      AppState.session = null;
      AppState.userProfile = null;
      localStorage.removeItem('advcontrol_session_cache');
      showToast("Sessão encerrada com sucesso.", "success");
      showAuthScreen(true);
    } catch (err) {
      showToast("Erro ao deslogar: " + err.message, "error");
    } finally {
      showLoader(false);
    }
  });

  // --- Listeners de Configurações & Onboarding ---
  _addEvent('wizardPrimaryColor', 'input', (e) => {
    const code = document.getElementById('wizardPrimaryColorCode');
    if (code) code.textContent = e.target.value.toUpperCase();
  });
  _addEvent('wizardSecondaryColor', 'input', (e) => {
    const code = document.getElementById('wizardSecondaryColorCode');
    if (code) code.textContent = e.target.value.toUpperCase();
  });

  _addEvent('settingsPrimaryColor', 'input', (e) => {
    const code = document.getElementById('settingsPrimaryColorCode');
    if (code) code.textContent = e.target.value.toUpperCase();
  });
  _addEvent('settingsSecondaryColor', 'input', (e) => {
    const code = document.getElementById('settingsSecondaryColorCode');
    if (code) code.textContent = e.target.value.toUpperCase();
  });

  // Preview de Logomarca no Onboarding Wizard
  _addEvent('wizardLogo', 'change', (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = function(evt) {
        wizardLogoBase64 = evt.target.result;
        const img = document.getElementById('wizardLogoPreview');
        const cont = document.getElementById('wizardLogoPreviewContainer');
        if (img) img.src = wizardLogoBase64;
        if (cont) cont.style.display = 'flex';
      };
      reader.readAsDataURL(file);
    }
  });

  // Preview de QR Code Pix no Onboarding Wizard
  _addEvent('wizardPixQR', 'change', (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = function(evt) {
        wizardPixQRBase64 = evt.target.result;
        const img = document.getElementById('wizardPixQRPreview');
        const cont = document.getElementById('wizardPixQRPreviewContainer');
        if (img) img.src = wizardPixQRBase64;
        if (cont) cont.style.display = 'flex';
      };
      reader.readAsDataURL(file);
    }
  });

  // Preview de Logomarca no Painel de Configurações
  _addEvent('settingsLogo', 'change', (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = function(evt) {
        settingsLogoBase64 = evt.target.result;
        const img = document.getElementById('settingsLogoPreview');
        const cont = document.getElementById('settingsLogoPreviewContainer');
        if (img) img.src = settingsLogoBase64;
        if (cont) cont.style.display = 'flex';
      };
      reader.readAsDataURL(file);
    }
  });

  // Preview de QR Code Pix no Painel de Configurações
  _addEvent('settingsPixQR', 'change', (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = function(evt) {
        settingsPixQRBase64 = evt.target.result;
        const img = document.getElementById('settingsPixQRPreview');
        const cont = document.getElementById('settingsPixQRPreviewContainer');
        if (img) img.src = settingsPixQRBase64;
        if (cont) cont.style.display = 'flex';
      };
      reader.readAsDataURL(file);
    }
  });
}

// =========================================================================
// UTILITÁRIOS GERAIS E AUXILIARES
// =========================================================================

function closeModal(overlayId) {
  document.getElementById(overlayId).classList.remove('active');
}

/**
 * Preenche um elemento Select dinamicamente
 */
function populateSelect(selectEl, list, valueKey, textKey, placeholderText = null) {
  selectEl.innerHTML = '';
  if (placeholderText) {
    selectEl.innerHTML += `<option value="">${placeholderText}</option>`;
  }
  list.forEach(item => {
    selectEl.innerHTML += `<option value="${item[valueKey]}">${item[textKey]}</option>`;
  });
}

/**
 * Formata um valor numérico para Moeda Real (R$)
 */
function formatCurrency(val) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  }).format(val);
}

/**
 * Formata data ISO para PT-BR (DD/MM/AAAA)
 */
function formatDate(dateStr) {
  if (!dateStr) return '---';
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return dateStr;
  return new Intl.DateTimeFormat('pt-BR').format(date);
}

/**
 * Controla tela de carregamento (Spinner geral)
 */
function showLoader(show) {
  // Cria dinamicamente ou manipula loader global
  let loader = document.getElementById('globalLoader');
  if (show) {
    if (!loader) {
      loader = document.createElement('div');
      loader.id = 'globalLoader';
      loader.style.position = 'fixed';
      loader.style.top = '0';
      loader.style.left = '0';
      loader.style.width = '100vw';
      loader.style.height = '100vh';
      loader.style.backgroundColor = 'rgba(5,7,13,0.7)';
      loader.style.backdropFilter = 'blur(4px)';
      loader.style.zIndex = '999999';
      loader.style.display = 'flex';
      loader.style.alignItems = 'center';
      loader.style.justifyContent = 'center';
      loader.innerHTML = `
        <div style="text-align: center;">
          <div style="border: 4px solid var(--border-color); border-top: 4px solid var(--primary); border-radius: 50%; width: 48px; height: 48px; animation: spin 1s linear infinite; margin: 0 auto 16px;"></div>
          <p style="font-size: 0.9rem; font-weight: 500; letter-spacing: 0.5px;">Sincronizando com Supabase...</p>
        </div>
        <style>
          @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        </style>
      `;
      document.body.appendChild(loader);
    }
    loader.style.display = 'flex';
  } else {
    if (loader) loader.style.display = 'none';
  }
}

/**
 * Exibe notificação flutuante temporária
 */
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  // Icone SVG customizado por tipo de feedback
  let icon = 'ℹ️';
  if (type === 'success') icon = '✔️';
  if (type === 'error') icon = '❌';
  if (type === 'warning') icon = '⚠️';

  toast.innerHTML = `
    <span>${icon}</span>
    <span style="flex-grow: 1;">${message}</span>
    <button class="toast-close" onclick="this.parentElement.remove()">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
    </button>
  `;
  container.appendChild(toast);
  
  // Auto-remove em 5 segundos
  setTimeout(() => {
    if (toast.parentElement) {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(50px)';
      setTimeout(() => toast.remove(), 300);
    }
  }, 5000);
}

// =========================================================================
// EMISSOR DE CARNÊS — CÁLCULO E GERAÇÃO
// =========================================================================

let billingLogoBase64 = (typeof JR_LOGO_BASE64 !== 'undefined') ? JR_LOGO_BASE64 : '';

/**
 * Inicializa a aba do Emissor de Carnês
 */
function initBillingGeneratorTab() {
  const addressInput = document.getElementById('bgAddress');
  const phoneInput = document.getElementById('bgPhone');
  const beneficiaryInput = document.getElementById('bgBeneficiary');
  const bankInput = document.getElementById('bgBank');
  const pixKeyInput = document.getElementById('bgPixKey');
  const firstDueDateInput = document.getElementById('bgFirstDueDate');

  // Preenche dados fixos e obrigatórios da Rego Júnior Advogados
  beneficiaryInput.value = "Rego Júnior Advogados";
  bankInput.value = "Banco Cora";
  pixKeyInput.value = "financeiro@regojunior.adv.br";
  phoneInput.value = "(11) 3254-8900";
  addressInput.value = "Av. Paulista, 1200 - Cj. 41 - Bela Vista - São Paulo/SP";

  // Inicializa logo corporativa fixa da Rego Júnior
  billingLogoBase64 = (typeof JR_LOGO_BASE64 !== 'undefined') ? JR_LOGO_BASE64 : '';

  // Define data padrão de vencimento para 30 dias a partir de hoje
  if (!firstDueDateInput.value) {
    const today = new Date();
    today.setDate(today.getDate() + 30);
    firstDueDateInput.value = today.toISOString().split('T')[0];
  }

  // Configura listeners para cálculo automático de parcelas
  const totalInput = document.getElementById('bgTotalValue');
  const installmentsInput = document.getElementById('bgInstallments');
  const installmentValInput = document.getElementById('bgInstallmentValue');

  const calculateInstallment = () => {
    const total = parseFloat(totalInput.value) || 0;
    const qty = parseInt(installmentsInput.value) || 1;
    if (qty > 0) {
      installmentValInput.value = (total / qty).toFixed(2);
    }
  };

  totalInput.removeEventListener('input', calculateInstallment);
  installmentsInput.removeEventListener('input', calculateInstallment);

  totalInput.addEventListener('input', calculateInstallment);
  installmentsInput.addEventListener('input', calculateInstallment);

  // Executa render inicial do preview se já houver preenchimento
  if (totalInput.value) {
    renderPreview();
  }
}

/**
 * Lida com o upload do arquivo de imagem e converte para Base64
 */
function handleLogoUpload(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(evt) {
    billingLogoBase64 = evt.target.result;
    showToast("Logomarca carregada com sucesso!", "success");
    renderPreview();
  };
  reader.readAsDataURL(file);
}

/**
 * Limpa o formulário de emissão
 */
function resetBillingForm() {
  document.getElementById('billingGeneratorForm').reset();
  billingLogoBase64 = (typeof JR_LOGO_BASE64 !== 'undefined') ? JR_LOGO_BASE64 : '';
  document.getElementById('carnePreviewContainer').innerHTML = `
    <div style="text-align: center; color: var(--text-muted); padding: 40px;">
      <svg viewBox="0 0 24 24" width="48" height="48" stroke="currentColor" stroke-width="1.5" fill="none" style="margin-bottom: 12px; color: var(--border-color);"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>
      <p>Preencha os campos e clique em <strong>Atualizar Pré-visualização</strong>.</p>
    </div>
  `;
  initBillingGeneratorTab();
}

/**
 * Constrói o HTML estruturado para as páginas A4 (3 boletos por folha)
 */
function generateCarneHtml(data) {
  let html = '';
  const totalInstallments = data.qty;
  const totalPages = Math.ceil(totalInstallments / 3);

  // Logo render string — SVG JR brânding padrão se nenhuma imagem for enviada
  const defaultLogoSvg = `
    <div class="slip-logo-default">
      <svg viewBox="0 0 80 50" xmlns="http://www.w3.org/2000/svg" width="110" height="68">
        <!-- Fundo -->
        <rect width="80" height="50" rx="4" fill="#111827"/>
        <!-- Linha dourada esquerda -->
        <rect x="5" y="8" width="2.5" height="34" rx="1" fill="#c9a84c"/>
        <!-- Letra J -->
        <text x="13" y="37" font-family="Georgia, serif" font-size="26" font-weight="700" fill="#c9a84c" letter-spacing="-1">J</text>
        <!-- Letra R -->
        <text x="31" y="37" font-family="Georgia, serif" font-size="26" font-weight="700" fill="#FFFFFF" letter-spacing="-1">R</text>
        <!-- Linha separadora -->
        <rect x="5" y="42" width="70" height="1" rx="0.5" fill="#c9a84c" opacity="0.6"/>
        <!-- Nome do escritório -->
        <text x="11" y="49" font-family="Arial, sans-serif" font-size="5.2" fill="#9ca3af" letter-spacing="1.2">REGO JÚNIOR ADVOGADOS</text>
      </svg>
    </div>
  `;
  const logoHtml = billingLogoBase64
    ? `<img src="${billingLogoBase64}" class="slip-logo-img">`
    : defaultLogoSvg;

  let currentInstallment = 1;
  const baseDueDate = new Date(data.firstDueDate + 'T00:00:00');

  for (let page = 1; page <= totalPages; page++) {
    html += `<div class="preview-a4-page">`;

    // Renderiza até 3 boletos por página
    for (let slip = 1; slip <= 3; slip++) {
      if (currentInstallment > totalInstallments) break;

      // Calcula data de vencimento correspondente à parcela atual
      const slipDueDate = new Date(baseDueDate);
      slipDueDate.setMonth(baseDueDate.getMonth() + (currentInstallment - 1));
      const formattedDueDate = formatDate(slipDueDate.toISOString().split('T')[0]);

      // Gera Payload PIX EMV real e dinâmico
      const pixPayload = generateStaticPixPayload(
        data.pixKey,
        data.beneficiary,
        "SAO PAULO",
        data.installmentVal,
        `${data.clientName.replace(/\s+/g, '')}PARC${currentInstallment}`
      );

      // Identificador único para o container do QR Code
      const qrContainerId = `qr-container-${page}-${slip}-${currentInstallment}`;

      html += `
        <div class="carne-slip">
          <!-- Cabeçalho -->
          <div class="slip-header">
            <div class="slip-logo-col">
              ${logoHtml}
            </div>
            <div class="slip-title-col">
              <h2>Boleto de Pagamento</h2>
            </div>
            <div class="slip-meta-col">
              <div class="slip-meta-box">
                <span class="slip-meta-label">Parcela</span>
                <span class="slip-meta-val">${String(currentInstallment).padStart(2, '0')}/${String(totalInstallments).padStart(2, '0')}</span>
              </div>
              <div class="slip-meta-box">
                <span class="slip-meta-label">Vencimento</span>
                <span class="slip-meta-val">${formattedDueDate}</span>
              </div>
            </div>
          </div>

          <!-- Pagador -->
          <div class="slip-row">
            <div class="slip-field">
              <span class="field-label">Pagador</span>
              <span class="field-value" style="font-size:0.85rem; font-weight:700;">${data.clientName}</span>
            </div>
          </div>

          <!-- Valores e Referência -->
          <div class="slip-row cols-3">
            <div class="slip-field">
              <span class="field-label">Valor da Parcela</span>
              <span class="field-value highlight">${formatCurrency(data.installmentVal)}</span>
            </div>
            <div class="slip-field">
              <span class="field-label">Valor Total Contratado</span>
              <span class="field-value">${formatCurrency(data.totalValue)}</span>
            </div>
            <div class="slip-field">
              <span class="field-label">Referência</span>
              <span class="field-value" style="font-size:0.7rem;">${data.reference}</span>
            </div>
          </div>

          <!-- Pix e Instruções -->
          <div class="slip-payment-grid">
            <!-- QR Code -->
            <div class="payment-qr-code" id="${qrContainerId}" data-payload="${pixPayload}">
              <!-- Canvas de QR gerado dinamicamente -->
            </div>

            <!-- Dados do Recebedor -->
            <div class="payment-details-box">
              <span class="payment-details-title">Pagamento via PIX</span>
              <div class="payment-detail-item"><strong>Chave PIX:</strong> ${data.pixKey}</div>
              <div class="payment-detail-item"><strong>Beneficiário:</strong> ${data.beneficiary}</div>
              <div class="payment-detail-item"><strong>Banco:</strong> ${data.bank}</div>
            </div>

            <!-- Instruções -->
            <div class="instructions-box">
              <span class="instructions-title">Instruções</span>
              <ul class="instructions-list">
                <li>Efetuar o pagamento até a data do vencimento.</li>
                <li>O pagamento poderá ser realizado via PIX utilizando o QR Code ou a chave PIX informada.</li>
                <li>O boleto também poderá ser pago diretamente na sede do escritório.</li>
                <li>Após o pagamento, encaminhar o comprovante para o WhatsApp do escritório.</li>
              </ul>
            </div>
          </div>

          <!-- Rodapé -->
          <div class="slip-footer">
            <span style="flex-grow: 1;">${data.address || 'Sem endereço cadastrado'}</span>
            <span>Tel: ${data.phone || 'Sem telefone'}</span>
          </div>
        </div>
      `;

      // Linha de corte somente se não for o último boleto da folha
      if (slip < 3 && currentInstallment < totalInstallments) {
        html += `<div class="carne-cut-line"></div>`;
      }

      currentInstallment++;
    }

    html += `</div>`; // .preview-a4-page
  }

  return html;
}

/**
 * Renderiza o Preview na tela gerando os QR Codes dinamicamente via biblioteca local
 */
function renderPreview() {
  const data = {
    clientName:     document.getElementById('bgClientName').value,
    totalValue:     parseFloat(document.getElementById('bgTotalValue').value) || 0,
    qty:            parseInt(document.getElementById('bgInstallments').value) || 1,
    installmentVal: parseFloat(document.getElementById('bgInstallmentValue').value) || 0,
    firstDueDate:   document.getElementById('bgFirstDueDate').value,
    reference:      document.getElementById('bgReference').value,
    beneficiary:    document.getElementById('bgBeneficiary').value,
    bank:           document.getElementById('bgBank').value,
    pixKey:         document.getElementById('bgPixKey').value,
    phone:          document.getElementById('bgPhone').value,
    address:        document.getElementById('bgAddress').value
  };

  const container = document.getElementById('carnePreviewContainer');
  
  // Renderiza HTML
  const rawHtml = generateCarneHtml(data);
  
  // Cria o elemento escala de preview
  container.innerHTML = `<div class="preview-scale-wrapper">${rawHtml}</div>`;

  // Inicializa os QR Codes em cada container usando qrcode.js
  const qrContainers = container.querySelectorAll('.payment-qr-code');
  qrContainers.forEach(div => {
    const payload = div.getAttribute('data-payload');
    new QRCode(div, {
      text: payload,
      width: 72,
      height: 72,
      colorDark: "#000000",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.M
    });
  });
}

/**
 * Copia o HTML formatado para a área de impressão de @media print e abre a caixa de diálogo
 */
function printBillingCarne() {
  const clientName = document.getElementById('bgClientName').value;
  if (!clientName) {
    showToast("Por favor preencha os dados e gere a visualização do carnê antes de imprimir.", "warning");
    return;
  }

  // Gera dados
  const data = {
    clientName:     document.getElementById('bgClientName').value,
    totalValue:     parseFloat(document.getElementById('bgTotalValue').value) || 0,
    qty:            parseInt(document.getElementById('bgInstallments').value) || 1,
    installmentVal: parseFloat(document.getElementById('bgInstallmentValue').value) || 0,
    firstDueDate:   document.getElementById('bgFirstDueDate').value,
    reference:      document.getElementById('bgReference').value,
    beneficiary:    document.getElementById('bgBeneficiary').value,
    bank:           document.getElementById('bgBank').value,
    pixKey:         document.getElementById('bgPixKey').value,
    phone:          document.getElementById('bgPhone').value,
    address:        document.getElementById('bgAddress').value
  };

  const printArea = document.getElementById('billingCarnePrintArea');
  
  // Renderiza HTML
  printArea.innerHTML = generateCarneHtml(data);

  // Inicializa os QR Codes
  const qrContainers = printArea.querySelectorAll('.payment-qr-code');
  qrContainers.forEach(div => {
    const payload = div.getAttribute('data-payload');
    new QRCode(div, {
      text: payload,
      width: 72,
      height: 72,
      colorDark: "#000000",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.M
    });
  });

  // Abre janela de impressão
  setTimeout(() => {
    window.print();
  }, 250);
}

/**
 * Gerador de Payload PIX Estático (EMV)
 */
function generateStaticPixPayload(key, beneficiary, city, amount, reference) {
  let payload = "000201";
  let merchantAccount = "0014br.gov.pix";
  merchantAccount += "01" + String(key.length).padStart(2, '0') + key;
  payload += "26" + String(merchantAccount.length).padStart(2, '0') + merchantAccount;
  payload += "52040000";
  payload += "5303986";
  
  if (amount > 0) {
    const amtStr = parseFloat(amount).toFixed(2);
    payload += "54" + String(amtStr.length).padStart(2, '0') + amtStr;
  }
  
  payload += "5802BR";
  
  const cleanName = beneficiary.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9\s]/g, "").substring(0, 25).toUpperCase();
  payload += "59" + String(cleanName.length).padStart(2, '0') + cleanName;
  
  const cleanCity = city.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9\s]/g, "").substring(0, 15).toUpperCase();
  payload += "60" + String(cleanCity.length).padStart(2, '0') + cleanCity;
  
  const cleanRef = reference.normalize("NFD").replace(/[^a-zA-Z0-9]/g, "").substring(0, 25).toUpperCase() || "CARNE";
  let txid = "05" + String(cleanRef.length).padStart(2, '0') + cleanRef;
  payload += "62" + String(txid.length).padStart(2, '0') + txid;
  
  payload += "6304";
  
  // Calculate CRC16 CCITT
  let crc = 0xFFFF;
  for (let i = 0; i < payload.length; i++) {
    let charCode = payload.charCodeAt(i);
    crc ^= (charCode << 8);
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
      } else {
        crc = (crc << 1) & 0xFFFF;
      }
    }
  }
  let crcHex = crc.toString(16).toUpperCase().padStart(4, '0');
  return payload + crcHex;
}

// =========================================================================
// ORGANIZAÇÃO E FLUXOS — TAREFAS E CHECKLISTS
// =========================================================================

/**
 * Inicializa a aba de Organização & Fluxos
 */
async function initOrganizationTab() {
  // Inicializa o seletor de responsáveis com os membros carregados
  const assigneeSelect = document.getElementById('orgTaskAssignee');
  assigneeSelect.innerHTML = '<option value="">Selecione um membro...</option>';
  
  if (AppState.members && AppState.members.length > 0) {
    AppState.members.forEach(member => {
      assigneeSelect.innerHTML += `<option value="${member.full_name}">${member.full_name}</option>`;
    });
  } else {
    if (AppState.userProfile) {
      assigneeSelect.innerHTML += `<option value="${AppState.userProfile.full_name}">${AppState.userProfile.full_name}</option>`;
    }
  }

  // Define data de vencimento padrão para amanhã
  const deadlineInput = document.getElementById('orgTaskDeadline');
  if (!deadlineInput.value) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    deadlineInput.value = tomorrow.toISOString().split('T')[0];
  }

  // Carrega tarefas do Supabase e renderiza
  showLoader(true);
  try {
    AppState.orgTasks = await getOrgTasks();
  } catch (err) {
    showToast("Erro ao carregar tarefas: " + err.message, "error");
  } finally {
    showLoader(false);
  }

  // Controle de exibição do formulário de criação de tarefas (apenas Dono/Sócio cria)
  const isOwner = (AppState.userProfile?.role === 'owner' || AppState.userProfile?.role === 'partner');
  const formCard = document.getElementById('orgTaskFormCard');
  const layoutGrid = document.getElementById('orgTasksLayoutGrid');
  if (formCard && layoutGrid) {
    if (isOwner) {
      formCard.style.display = '';
      layoutGrid.style.gridTemplateColumns = '1fr 1.8fr';
    } else {
      formCard.style.display = 'none';
      layoutGrid.style.gridTemplateColumns = '1fr';
    }
  }

  renderOrgTasksTable();
}

/**
 * Alterna entre as sub-abas de Organização (Tarefas / Checklist / Fluxos)
 */
function switchOrgSubTab(subtabId) {
  // Oculta todas as sub-abas
  const panes = document.querySelectorAll('.org-subtab-pane');
  panes.forEach(pane => pane.style.display = 'none');

  // Mostra a sub-aba ativa
  document.getElementById(`subtab-${subtabId}`).style.display = 'block';

  // Atualiza botões
  const tabButtons = document.querySelectorAll('.btn-org-tab');
  tabButtons.forEach(btn => {
    if (btn.getAttribute('data-subtab') === subtabId) {
      btn.classList.add('btn-primary');
      btn.classList.remove('btn-secondary');
      btn.classList.add('active');
    } else {
      btn.classList.add('btn-secondary');
      btn.classList.remove('btn-primary');
      btn.classList.remove('active');
    }
  });
}

/**
 * Adiciona uma nova tarefa na Lista de Afazeres (salva no Supabase)
 */
async function addOrgTask() {
  const activity = document.getElementById('orgTaskActivity').value.trim();
  const assignee = document.getElementById('orgTaskAssignee').value;
  const deadline = document.getElementById('orgTaskDeadline').value;
  const description = document.getElementById('orgTaskDescription').value.trim();

  if (!activity || !assignee || !deadline) {
    showToast("Preencha todos os campos antes de adicionar.", "warning");
    return;
  }

  const tenantId = AppState.userProfile?.tenant_id;
  if (!tenantId) return;

  showLoader(true);
  try {
    const newTask = await createOrgTask(tenantId, {
      activity,
      assignee_name: assignee,
      deadline,
      description: description || null,
      created_by: AppState.userProfile.id
    });
    AppState.orgTasks.push(newTask);
    showToast("Tarefa adicionada com sucesso!", "success");
    document.getElementById('orgTaskForm').reset();
    renderOrgTasksTable();
  } catch (err) {
    showToast("Erro ao salvar tarefa: " + err.message, "error");
  } finally {
    showLoader(false);
  }
}

/**
 * Alterna o status 'concluído' de uma tarefa no Supabase
 */
async function toggleOrgTaskStatus(taskId) {
  const task = AppState.orgTasks.find(t => t.id === taskId);
  if (!task) return;

  const newDone = !task.done;
  try {
    await toggleOrgTaskDone(taskId, newDone);
    task.done = newDone;
    task.done_at = newDone ? new Date().toISOString() : null;
    renderOrgTasksTable();
  } catch (err) {
    showToast("Erro ao atualizar tarefa: " + err.message, "error");
  }
}

/**
 * Deleta uma tarefa do Supabase
 */
async function handleDeleteOrgTask(taskId) {
  if (!confirm("Deseja realmente excluir esta tarefa?")) return;
  try {
    await deleteOrgTask(taskId);
    AppState.orgTasks = AppState.orgTasks.filter(t => t.id !== taskId);
    showToast("Tarefa removida.", "info");
    renderOrgTasksTable();
  } catch (err) {
    showToast("Erro ao excluir tarefa: " + err.message, "error");
  }
}

function normalizeStr(str) {
  if (!str) return '';
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

/**
 * Renderiza a tabela de tarefas na tela
 */
function renderOrgTasksTable() {
  const tbody = document.getElementById('orgTasksTableBody');
  const countBadge = document.getElementById('orgTaskCount');
  
  let tasks = AppState.orgTasks || [];
  const role = AppState.userProfile?.role;
  const userFullName = AppState.userProfile?.full_name;
  const isOwner = (role === 'owner' || role === 'partner');
  
  // Apenas associados têm a visualização restrita às suas próprias tarefas atribuídas.
  // Donos (owner), Sócios (partner), Secretárias (secretary) e Financeiro (financial) enxergam todas as tarefas do escritório.
  if (role === 'associate' && userFullName) {
    tasks = tasks.filter(t => {
      const assigneeName = t.assignee_name || t.assignee || '';
      return normalizeStr(assigneeName) === normalizeStr(userFullName);
    });
  }
  
  // Oculta ou mostra o cabeçalho da coluna de Ações na tabela
  const headerActions = document.querySelector('#subtab-org-tasks table th:last-child');
  if (headerActions) {
    headerActions.style.display = isOwner ? '' : 'none';
  }
  
  tbody.innerHTML = '';
  let pendingCount = 0;

  if (tasks.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="${isOwner ? '5' : '4'}" style="text-align: center; color: var(--text-muted); padding: 30px;">
          Nenhuma tarefa cadastrada para hoje.
        </td>
      </tr>
    `;
    countBadge.textContent = "0 pendentes";
    return;
  }

  // Ordena: pendentes primeiro, depois por prazo mais próximo
  const sorted = [...tasks].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    return new Date(a.deadline) - new Date(b.deadline);
  });

  sorted.forEach(task => {
    if (!task.done) pendingCount++;

    const isOverdue = !task.done && new Date(task.deadline + 'T23:59:59') < new Date();
    const deadlineStyle = isOverdue ? 'style="color: var(--danger); font-weight: 600;"' : '';
    const formattedDeadline = formatDate(task.deadline);
    // Suporte a campo assignee_name (Supabase) ou assignee (localStorage legado)
    const assigneeName = task.assignee_name || task.assignee || '---';

    const actionCell = isOwner 
      ? `<td style="text-align: center;">
          <button class="btn-action btn-delete" onclick="handleDeleteOrgTask('${task.id}')" title="Excluir tarefa">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
        </td>`
      : '';

    // Estilização do status dropdown de forma bonita
    let selectBg = '#fff8e1'; // pendente (amarelo)
    let selectColor = '#b78103';
    if (task.done) {
      selectBg = '#e8f5e9'; // feito (verde)
      selectColor = '#2e7d32';
    } else if (isOverdue) {
      selectBg = '#ffebee'; // não feito / atrasado (vermelho)
      selectColor = '#c62828';
    }

    const selectStyle = `background: ${selectBg}; color: ${selectColor}; border: 1px solid ${selectColor}40; border-radius: 4px; padding: 4px 8px; font-size: 0.8rem; font-weight: 600; cursor: pointer; outline: none; font-family: var(--font-main);`;

    const statusDropdown = `
      <select onchange="updateOrgTaskStatusSelect('${task.id}', this.value)" style="${selectStyle}">
        <option value="pending" ${!task.done && !isOverdue ? 'selected' : ''}>🟡 Pendente</option>
        <option value="not_done" ${!task.done && isOverdue ? 'selected' : ''}>🔴 Não Feito</option>
        <option value="done" ${task.done ? 'selected' : ''}>🟢 Feito</option>
      </select>
    `;

    tbody.innerHTML += `
      <tr style="${task.done ? 'opacity: 0.7;' : ''}">
        <td style="text-align: center;">
          ${statusDropdown}
        </td>
        <td>
          <strong>${task.activity}</strong>
          ${task.description ? `<div style="font-size: 0.78rem; color: var(--text-muted); margin-top: 4px; font-weight: normal; font-style: italic;">💬 ${task.description}</div>` : ''}
        </td>
        <td><span class="badge" style="background: rgba(255,255,255,0.05); color: var(--text-primary); border: 1px solid var(--border-color);">${assigneeName}</span></td>
        <td ${deadlineStyle}>${formattedDeadline} ${isOverdue ? '⚠️ Atrasado' : ''}</td>
        ${actionCell}
      </tr>
    `;
  });

  countBadge.textContent = `${pendingCount} pendente(s)`;
}

/**
 * Atualiza o status da tarefa no Supabase via seletor dropdown
 */
async function updateOrgTaskStatusSelect(taskId, value) {
  const task = AppState.orgTasks.find(t => t.id === taskId);
  if (!task) return;

  const isDone = (value === 'done');
  
  try {
    showLoader(true);
    await toggleOrgTaskDone(taskId, isDone);
    task.done = isDone;
    task.done_at = isDone ? new Date().toISOString() : null;
    showToast("Status da tarefa atualizado com sucesso!", "success");
    renderOrgTasksTable();
  } catch (err) {
    showToast("Erro ao atualizar status: " + err.message, "error");
  } finally {
    showLoader(false);
  }
}

/**
 * Abre o Modal com a Lista de Documentação Específica do Cliente
 */
function openClientDocChecklistModal(clientId) {
  const title = document.getElementById('clientDocModalTitle');
  const idInput = document.getElementById('clientDocModalClientId');

  idInput.value = clientId;

  // Busca o nome do cliente selecionado no cache
  const clientObj = AppState.clients.find(c => c.id === clientId);
  const clientName = clientObj ? clientObj.name : 'Cliente';

  // Configura título do modal
  title.innerHTML = `Documentos de: <span style="color:#b89764; font-family:Georgia, serif;">${clientName}</span>`;

  // Reseta todos os checkboxes do modal
  document.getElementById('chkDocRg').checked = false;
  document.getElementById('chkDocCpf').checked = false;
  document.getElementById('chkDocAddress').checked = false;
  document.getElementById('chkDocProxy').checked = false;
  document.getElementById('chkDocContract').checked = false;
  document.getElementById('chkDocPoverty').checked = false;
  document.getElementById('chkDocProof').checked = false;

  // Lê do localStorage o estado salvo deste cliente específico
  const docStatus = JSON.parse(localStorage.getItem(`doc_chk_${clientId}`) || '{}');

  // Aplica o status de check
  if (docStatus.rg)       document.getElementById('chkDocRg').checked = true;
  if (docStatus.cpf)      document.getElementById('chkDocCpf').checked = true;
  if (docStatus.address)  document.getElementById('chkDocAddress').checked = true;
  if (docStatus.proxy)    document.getElementById('chkDocProxy').checked = true;
  if (docStatus.contract) document.getElementById('chkDocContract').checked = true;
  if (docStatus.poverty)  document.getElementById('chkDocPoverty').checked = true;
  if (docStatus.proof)    document.getElementById('chkDocProof').checked = true;

  // Abre o modal usando o padrão correto do projeto
  document.getElementById('clientDocModalOverlay').classList.add('active');
}

/**
 * Salva as alterações de documentação do cliente a partir do Modal
 */
function saveClientDocChecklistFromModal() {
  const clientId = document.getElementById('clientDocModalClientId').value;
  if (!clientId) return;

  const docStatus = {
    rg:       document.getElementById('chkDocRg').checked,
    cpf:      document.getElementById('chkDocCpf').checked,
    address:  document.getElementById('chkDocAddress').checked,
    proxy:    document.getElementById('chkDocProxy').checked,
    contract: document.getElementById('chkDocContract').checked,
    poverty:  document.getElementById('chkDocPoverty').checked,
    proof:    document.getElementById('chkDocProof').checked
  };

  // Salva no localStorage com chave única por cliente
  localStorage.setItem(`doc_chk_${clientId}`, JSON.stringify(docStatus));
  
  closeModal('clientDocModalOverlay');
  showToast("Checklist de documentação atualizado!", "success");
}

/**
 * Renderiza o checklist interativo de onboarding na aba Primeiros Passos
 */
function renderOnboardingChecklist() {
  const steps = {
    client: AppState.clients && AppState.clients.length > 0,
    case: AppState.cases && AppState.cases.length > 0,
    tx: AppState.transactions && AppState.transactions.length > 0,
    member: AppState.members && AppState.members.length > 1
  };

  // Passo 1 é sempre completado
  updateStepVisual('step-office', 'icon-step-office', true);

  // Demais passos baseados no cache real do app
  updateStepVisual('step-client', 'icon-step-client', steps.client, 'badge-step-client');
  updateStepVisual('step-case', 'icon-step-case', steps.case, 'badge-step-case');
  updateStepVisual('step-tx', 'icon-step-tx', steps.tx, 'badge-step-tx');
  updateStepVisual('step-member', 'icon-step-member', steps.member, 'badge-step-member');
}

function updateStepVisual(cardId, iconId, isCompleted, badgeId) {
  const card = document.getElementById(cardId);
  const icon = document.getElementById(iconId);
  const badge = badgeId ? document.getElementById(badgeId) : null;

  if (isCompleted) {
    if (card) {
      card.style.background = 'rgba(22, 163, 74, 0.04)';
      card.style.borderColor = 'rgba(22, 163, 74, 0.3)';
    }
    if (icon) {
      icon.innerHTML = '✔️';
      icon.style.color = 'var(--success)';
    }
    if (badge) {
      badge.textContent = 'Concluído';
      badge.className = 'badge badge-pago';
      badge.style.background = 'var(--success-light)';
      badge.style.color = 'var(--success)';
    }
  } else {
    if (card) {
      card.style.background = '#FAFAF8';
      card.style.borderColor = 'var(--border-color)';
    }
    if (icon) {
      icon.innerHTML = '⬜';
      icon.style.color = 'var(--text-muted)';
    }
    if (badge) {
      badge.textContent = 'Pendente';
      badge.className = 'badge';
      badge.style.background = 'var(--border-color)';
      badge.style.color = 'var(--text-muted)';
    }
  }
}

/**
 * Função de busca global por clientes e processos/casos
 */
window.handleGlobalSearch = function() {
  const input = document.getElementById('globalSearchInput');
  const resultsDiv = document.getElementById('globalSearchResults');
  const query = input.value.toLowerCase().trim();

  if (!query) {
    resultsDiv.style.display = 'none';
    resultsDiv.innerHTML = '';
    return;
  }

  // Busca Clientes
  const matchedClients = AppState.clients.filter(c => 
    c.name.toLowerCase().includes(query) || 
    (c.email && c.email.toLowerCase().includes(query)) ||
    (c.document && c.document.includes(query))
  );

  // Busca Casos
  const matchedCases = AppState.cases.filter(c => 
    c.title.toLowerCase().includes(query) || 
    (c.case_number && c.case_number.toLowerCase().includes(query))
  );

  if (matchedClients.length === 0 && matchedCases.length === 0) {
    resultsDiv.innerHTML = `<div style="padding: 12px; font-size: 0.8rem; color: var(--text-muted); text-align: center;">Nenhum resultado encontrado</div>`;
    resultsDiv.style.display = 'block';
    return;
  }

  let html = '';
  
  if (matchedClients.length > 0) {
    html += `<div style="padding: 8px 12px 4px; font-size: 0.7rem; font-weight: 800; text-transform: uppercase; color: var(--primary); border-bottom: 1px solid var(--border-color); background: #F7F5F0;">Clientes</div>`;
    matchedClients.slice(0, 5).forEach(c => {
      html += `
        <div onclick="navigateToGlobalResult('clients', '${c.name.replace(/'/g, "\\'")}')" style="padding: 10px 12px; cursor: pointer; transition: var(--transition); border-bottom: 1px solid #F2F0EB; display: flex; flex-direction: column; gap: 2px;" class="search-result-item">
          <span style="font-size: 0.82rem; font-weight: 700; color: var(--text-main);">${c.name}</span>
          <span style="font-size: 0.72rem; color: var(--text-muted);">${c.email || 'Sem email'} &bull; ${c.document || 'Sem documento'}</span>
        </div>`;
    });
  }

  if (matchedCases.length > 0) {
    html += `<div style="padding: 8px 12px 4px; font-size: 0.7rem; font-weight: 800; text-transform: uppercase; color: var(--info); border-bottom: 1px solid var(--border-color); background: #F7F5F0; margin-top: 4px;">Casos / Processos</div>`;
    matchedCases.slice(0, 5).forEach(c => {
      html += `
        <div onclick="navigateToGlobalResult('cases', '${c.title.replace(/'/g, "\\'")}')" style="padding: 10px 12px; cursor: pointer; transition: var(--transition); border-bottom: 1px solid #F2F0EB; display: flex; flex-direction: column; gap: 2px;" class="search-result-item">
          <span style="font-size: 0.82rem; font-weight: 700; color: var(--text-main);">${c.title}</span>
          <span style="font-size: 0.72rem; color: var(--text-muted);">Nº ${c.case_number || 'Não informado'}</span>
        </div>`;
    });
  }

  resultsDiv.innerHTML = html;
  resultsDiv.style.display = 'block';
};

window.navigateToGlobalResult = function(tabId, searchVal) {
  // Limpa barra de busca global
  document.getElementById('globalSearchInput').value = '';
  document.getElementById('globalSearchResults').style.display = 'none';

  // Navega para a aba correta
  switchTab(tabId);

  // Insere termo no campo de busca local correspondente e filtra
  if (tabId === 'clients') {
    const input = document.getElementById('searchClient');
    if (input) {
      input.value = searchVal;
      renderClientsTable();
    }
  } else if (tabId === 'cases') {
    const input = document.getElementById('searchCase');
    if (input) {
      input.value = searchVal;
      renderCasesTable();
    }
  }
};

// Listener para esconder os resultados da busca global ao clicar fora
document.addEventListener('click', function(e) {
  const wrapper = document.querySelector('.global-search-wrapper');
  if (wrapper && !wrapper.contains(e.target)) {
    const results = document.getElementById('globalSearchResults');
    if (results) results.style.display = 'none';
  }
});

// =========================================================================
// INTEGRAÇÃO DE INTELIGÊNCIA ARTIFICIAL: DOUTOR IA EXPLICA
// =========================================================================

const GEMINI_API_KEY = 'AQ.Ab8RN6LIaHB84e2gofarA2d5ROLtHBLxUnBaMaijuiWE-rCWgA';

function getEffectiveGeminiKey() {
  return localStorage.getItem('advcontrol_gemini_api_key') || GEMINI_API_KEY || '';
}

/**
 * Retorna um histórico simulado de andamentos complexos (juridiquês) para a IA processar.
 * Caso o processo seja real (CNJ), simula andamentos realistas baseado na matéria.
 */
function getMockCaseAndamentos(caseObj) {
  const title = (caseObj.title || '').toLowerCase();
  
  if (title.includes('trabalhista') || title.includes('reclamacao') || title.includes('demissao')) {
    return [
      "14/07/2026 - Expedida notificação postal de audiência de instrução e julgamento para as partes.",
      "22/06/2026 - Apresentada contestação com documentos sob sigilo pela reclamada (ID: a3bc78f).",
      "10/05/2026 - Certidão de decurso de prazo para manifestação sobre cálculos homologatórios.",
      "18/04/2026 - Despacho: intime-se o reclamante para se manifestar sobre a defesa e documentos no prazo de 10 dias.",
      "05/03/2026 - Protocolada Petição Inicial sob o rito ordinário com pedido de tutela provisória de urgência."
    ].join("\n");
  }

  if (title.includes('alimentos') || title.includes('familia') || title.includes('guarda') || title.includes('divorcio')) {
    return [
      "12/07/2026 - Conclusos para despacho/decisão de fixação de alimentos provisórios e designação de audiência.",
      "30/06/2026 - Juntada de parecer do Ministério Público opinando pela concessão de tutela de alimentos provisórios à menor.",
      "18/06/2026 - Certidão de juntada de comprovante de citação do réu via oficial de justiça.",
      "04/05/2026 - Despacho: defiro a gratuidade de justiça e determino a expedição de mandado de citação e intimação do devedor."
    ].join("\n");
  }

  // Padrão Geral / Cível (Danos Morais, Injúria, etc.)
  return [
    "15/07/2026 - Conclusos para sentença de mérito na secretaria da 4ª Vara Cível.",
    "18/06/2026 - Juntada de petição de Alegações Finais por Memoriais pelo Autor (ID: 99827a).",
    "05/06/2026 - Decisão: declaro encerrada a fase de instrução processual e concedo prazo comum de 15 dias para alegações finais.",
    "14/05/2026 - Termo de Audiência de Instrução e Julgamento juntado aos autos com depoimento pessoal do réu e oitiva de duas testemunhas.",
    "20/04/2026 - Despacho saneador: fixo os pontos controvertidos e defiro a produção de prova oral, designando audiência de instrução."
  ].join("\n");
}

let activeAICaseId = null;

/**
 * Abre o modal do Doutor IA, carrega dados em cache ou chama API do Gemini.
 */
window.openCaseAIModal = async function(caseId) {
  activeAICaseId = caseId;
  const caseObj = AppState.cases.find(c => c.id === caseId);
  if (!caseObj) return;

  const modalTitle = document.getElementById('caseAIModalTitle');
  modalTitle.innerHTML = `🤖 Doutor IA — Análise de Processo: <span style="color: var(--primary);">${caseObj.title}</span>`;

  // Reseta abas do modal
  switchAIModalTab('client');

  // Abre modal
  document.getElementById('caseAIModalOverlay').classList.add('active');

  // Verifica cache local
  const cachedData = localStorage.getItem(`case_ai_analysis_${caseId}`);
  if (cachedData) {
    renderAIResults(JSON.parse(cachedData));
  } else {
    await fetchCaseAIAnalysis(caseObj);
  }
};

/**
 * Executa a chamada à API do Gemini e atualiza a interface
 */
async function fetchCaseAIAnalysis(caseObj) {
  const loader = document.getElementById('caseAILoader');
  const content = document.getElementById('caseAIContent');

  loader.style.display = 'block';
  content.style.display = 'none';

  const andamentos = getMockCaseAndamentos(caseObj);
  const prompt = `
Você é um assistente jurídico de inteligência artificial extremamente competente e empático chamado "Doutor IA", responsável por traduzir o andamento processual para o cliente final e sugerir tarefas ao advogado.

Analise o seguinte histórico de movimentações jurídicas reais (andamentos processuais do tribunal) deste caso de título "${caseObj.title}" e número de processo "${caseObj.case_number || 'Não informado'}":

${andamentos}

Você deve obrigatoriamente responder com um objeto JSON estruturado contendo exatamente estes 4 campos de string:
1. "status_simplificado": Um resumo de apenas 1 frase curta e clara explicando o estado atual (ex: "O processo está na mesa do juiz esperando a sentença final").
2. "explicacao_juridiquez": Um texto amigável em linguagem simples explicando de forma clara o que aconteceu nos últimos andamentos, sem jargões jurídicos confusos.
3. "proximos_passos_cliente": O que o cliente final deve fazer agora ou qual deve ser a expectativa dele em linguagem reconfortante.
4. "proximos_passos_advogado": Uma lista detalhada em tópicos (usando tags HTML de listas ou parágrafos) com as ações técnicas e providências que o advogado do caso precisa tomar a seguir.

Atenção: Retorne APENAS o JSON no formato puro. Não inclua blocos de código markdown ou texto explicativo extra fora do JSON.
`;

  try {
    const model = "gemini-1.5-flash";
    const apiKey = getEffectiveGeminiKey();
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: prompt
          }]
        }],
        generationConfig: {
          responseMimeType: "application/json"
        }
      })
    });

    if (!response.ok) {
      let errMsg = response.statusText;
      try {
        const errJson = await response.json();
        errMsg = errJson.error?.message || JSON.stringify(errJson);
      } catch (e) {
        try {
          errMsg = await response.text();
        } catch (e2) {}
      }
      throw new Error(`Código ${response.status}: ${errMsg}`);
    }

    const data = await response.json();
    const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!responseText) {
      throw new Error("Resposta da IA vazia ou malformada.");
    }

    const parsedJson = JSON.parse(responseText.trim());
    
    // Salva no cache do localStorage
    localStorage.setItem(`case_ai_analysis_${caseObj.id}`, JSON.stringify(parsedJson));
    
    renderAIResults(parsedJson);

  } catch (error) {
    console.error("Erro na análise da IA:", error);
    showToast("Erro ao processar análise da IA: " + error.message, "error");
    closeModal('caseAIModalOverlay');
  } finally {
    loader.style.display = 'none';
  }
}

/**
 * Renderiza os dados do JSON da IA no modal
 */
function renderAIResults(data) {
  document.getElementById('caseAIStatus').textContent = data.status_simplificado || '---';
  document.getElementById('caseAIExplanation').innerHTML = (data.explicacao_juridiquez || '---').replace(/\n/g, '<br>');
  document.getElementById('caseAINextStepClient').innerHTML = (data.proximos_passos_cliente || '---').replace(/\n/g, '<br>');
  document.getElementById('caseAINextStepLawyer').innerHTML = (data.proximos_passos_advogado || '---').replace(/\n/g, '<br>');

  document.getElementById('caseAILoader').style.display = 'none';
  document.getElementById('caseAIContent').style.display = 'block';
}

/**
 * Alterna as abas dentro do modal da IA (Cliente / Advogado)
 */
function switchAIModalTab(tabType) {
  const btnClient = document.getElementById('btnTabAIClient');
  const btnLawyer = document.getElementById('btnTabAILawyer');
  const panelClient = document.getElementById('panelAIClient');
  const panelLawyer = document.getElementById('panelAILawyer');

  if (tabType === 'client') {
    btnClient.style.color = 'var(--primary)';
    btnClient.style.borderBottom = '2px solid var(--primary)';
    btnClient.style.fontWeight = '800';

    btnLawyer.style.color = 'var(--text-muted)';
    btnLawyer.style.borderBottom = 'none';
    btnLawyer.style.fontWeight = '600';

    panelClient.style.display = 'block';
    panelLawyer.style.display = 'none';
  } else {
    btnLawyer.style.color = 'var(--primary)';
    btnLawyer.style.borderBottom = '2px solid var(--primary)';
    btnLawyer.style.fontWeight = '800';

    btnClient.style.color = 'var(--text-muted)';
    btnClient.style.borderBottom = 'none';
    btnClient.style.fontWeight = '600';

    panelClient.style.display = 'none';
    panelLawyer.style.display = 'block';
  }
}

// Vincula eventos das abas internas do modal
document.getElementById('btnTabAIClient').addEventListener('click', () => switchAIModalTab('client'));
document.getElementById('btnTabAILawyer').addEventListener('click', () => switchAIModalTab('lawyer'));

// Eventos de fechamento do modal
document.getElementById('btnCloseCaseAIModal').addEventListener('click', () => closeModal('caseAIModalOverlay'));
document.getElementById('btnExitCaseAI').addEventListener('click', () => closeModal('caseAIModalOverlay'));

// Força recálculo da análise limpando o cache
document.getElementById('btnRefreshCaseAI').addEventListener('click', async () => {
  if (activeAICaseId) {
    const caseObj = AppState.cases.find(c => c.id === activeAICaseId);
    if (caseObj) {
      localStorage.removeItem(`case_ai_analysis_${activeAICaseId}`);
      await fetchCaseAIAnalysis(caseObj);
    }
  }
});

// =========================================================================
// INTEGRAÇÃO DE INTELIGÊNCIA ARTIFICIAL: ASSISTENTE DE REDAÇÃO JURÍDICA
// =========================================================================

let activeDraftCaseId = null;

window.openLegalDraftModal = function(caseId) {
  activeDraftCaseId = caseId;
  const caseObj = AppState.cases.find(c => c.id === caseId);
  if (!caseObj) return;

  document.getElementById('legalDraftCaseId').value = caseId;
  document.getElementById('legalDraftTextArea').value = '';
  document.getElementById('legalDraftContent').style.display = 'none';
  document.getElementById('legalDraftLoader').style.display = 'none';

  document.getElementById('legalDraftModalOverlay').classList.add('active');
};

document.getElementById('btnCloseLegalDraftModal').addEventListener('click', () => closeModal('legalDraftModalOverlay'));

document.getElementById('btnGenerateLegalDraft').addEventListener('click', async () => {
  const caseId = document.getElementById('legalDraftCaseId').value;
  const draftType = document.getElementById('legalDraftTypeSelect').value;
  const caseObj = AppState.cases.find(c => c.id === caseId);
  if (!caseObj) return;

  const loader = document.getElementById('legalDraftLoader');
  const content = document.getElementById('legalDraftContent');

  loader.style.display = 'block';
  content.style.display = 'none';

  const clientName = caseObj.clients?.name || '__________________________';
  const clientDoc = caseObj.clients?.document || '__________________________';
  const clientEmail = caseObj.clients?.email || '__________________________';
  
  const docLabels = {
    proposta: 'Proposta de Honorários Advocatícios Contratuais',
    contrato: 'Contrato de Prestação de Serviços de Advocacia e Consultoria Jurídica',
    peticao: 'Petição Inicial (Esboço / Rascunho da Inicial)'
  };
  const docLabel = docLabels[draftType];

  const prompt = `
Você é um excelente advogado sênior brasileiro e assistente de redação jurídica.
Redija uma peça/documento jurídico em formato de texto estruturado e formal:
Tipo de Documento: ${docLabel}
Título do Caso/Objeto: ${caseObj.title}
Número do Processo/CNJ: ${caseObj.case_number || 'Ainda não distribuído (Em fase prévia)'}
Cliente: ${clientName}
CPF/CNPJ do Cliente: ${clientDoc}
E-mail do Cliente: ${clientEmail}

Instruções importantes:
1. Redija o documento de forma extremamente profissional, polida, formal e completa em português (Brasil).
2. Se for Contrato, inclua cláusulas de honorários, objeto, obrigações das partes, foro da comarca e encerramento.
3. Se for Proposta, detalhe as atividades que serão desempenhadas, a forma de pagamento recomendada para este tipo de objeto e cláusulas de validade.
4. Se for Petição Inicial, monte a estrutura de endereçamento, dos fatos (crie um rascunho com base no objeto), dos direitos e dos pedidos finais de forma preliminar.
5. Retorne APENAS o texto completo do documento formatado com parágrafos, espaçamentos e linhas de assinatura. Não inclua blocos markdown (ex: \`\`\`html ou \`\`\`text), nem notas ou conversas fora do documento.
`;

  try {
    const model = "gemini-1.5-flash";
    const apiKey = getEffectiveGeminiKey();
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: prompt
          }]
        }]
      })
    });

    if (!response.ok) {
      let errMsg = response.statusText;
      try {
        const errJson = await response.json();
        errMsg = errJson.error?.message || JSON.stringify(errJson);
      } catch (e) {
        try {
          errMsg = await response.text();
        } catch (e2) {}
      }
      throw new Error(`Código ${response.status}: ${errMsg}`);
    }

    const data = await response.json();
    const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!responseText) {
      throw new Error("Não foi possível gerar o rascunho do documento.");
    }

    document.getElementById('legalDraftTextArea').value = responseText.trim();
    content.style.display = 'block';

  } catch (error) {
    console.error("Erro na redação da IA:", error);
    showToast("Erro ao redigir documento: " + error.message, "error");
  } finally {
    loader.style.display = 'none';
  }
});

// Copia o texto do rascunho de redação para a área de transferência
document.getElementById('btnCopyLegalDraft').addEventListener('click', () => {
  const text = document.getElementById('legalDraftTextArea').value;
  if (!text) return;

  navigator.clipboard.writeText(text);
  showToast("Texto copiado para a área de transferência!", "success");
});

// Envia o texto da redação via WhatsApp
document.getElementById('btnShareWhatsAppDraft').addEventListener('click', () => {
  const text = document.getElementById('legalDraftTextArea').value;
  if (!text) return;

  const url = `https://api.whatsapp.com/send?text=${encodeURIComponent(text.slice(0, 1500) + "\n\n[Texto reduzido. Proposta completa copiada para a área de transferência]")}`;
  window.open(url, '_blank');
});

// =========================================================================
// INTEGRAÇÃO DE INTELIGÊNCIA ARTIFICIAL: SCAN IA & OCR DE DOCUMENTOS
// =========================================================================

/**
 * Lê o arquivo em Base64 e envia para a API Multimodal do Gemini 1.5 Flash
 */
window.handleDocumentUpload = function(inputEl, docType) {
  const file = inputEl.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async function() {
    const base64Data = reader.result.split(',')[1];
    const mimeType = file.type;

    await analyzeDocumentWithAI(base64Data, mimeType, docType);
  };
  reader.readAsDataURL(file);
  
  // Limpa o input do arquivo para permitir nova carga
  inputEl.value = '';
};

async function analyzeDocumentWithAI(base64Data, mimeType, docType) {
  const loader = document.getElementById('docAILoader');
  const clientId = document.getElementById('clientDocModalClientId').value;
  
  if (loader) loader.style.display = 'block';

  const docLabels = {
    rg: 'Identidade Oficial (RG, CNH ou OAB)',
    cpf: 'Cadastro de Pessoa Física (CPF)',
    address: 'Comprovante de Residência'
  };

  const prompt = `
Você é uma inteligência artificial de OCR e validação de documentos jurídicos.
Sua tarefa é analisar a imagem do documento fornecida anexada e identificar se corresponde a um documento do tipo "${docLabels[docType]}".
Valide se está legível e extraia as informações estruturadas.

Você deve responder rigorosamente com um objeto JSON puro, sem blocos de código markdown ou texto externo:
{
  "valido": true ou false (se o documento é de fato o tipo solicitado e está legível),
  "tipo_documento": "Identidade" ou "CPF" ou "Comprovante Residência" ou "Outro",
  "dados_extraidos": {
    "nome": "Nome completo encontrado no documento",
    "cpf": "Número do CPF formatado (se houver)",
    "rg": "Número do RG (se houver)",
    "endereco": "Endereço completo com rua, número, bairro e cidade (apenas se for comprovante de residência)"
  },
  "feedback": "Explicar brevemente o que foi extraído ou por que o documento é inválido/ilegível."
}
`;

  try {
    const model = "gemini-1.5-flash";
    const apiKey = getEffectiveGeminiKey();
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType: mimeType,
                data: base64Data
              }
            }
          ]
        }],
        generationConfig: {
          responseMimeType: "application/json"
        }
      })
    });

    if (!response.ok) {
      let errMsg = response.statusText;
      try {
        const errJson = await response.json();
        errMsg = errJson.error?.message || JSON.stringify(errJson);
      } catch (e) {
        try {
          errMsg = await response.text();
        } catch (e2) {}
      }
      throw new Error(`Código ${response.status}: ${errMsg}`);
    }

    const data = await response.json();
    const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!responseText) {
      throw new Error("A IA não retornou resposta legível.");
    }

    const parsedJson = JSON.parse(responseText.trim());

    if (parsedJson.valido) {
      // 1. Marca o checkbox correspondente no modal
      const chkId = {
        rg: 'chkDocRg',
        cpf: 'chkDocCpf',
        address: 'chkDocAddress'
      }[docType];
      
      const checkbox = document.getElementById(chkId);
      if (checkbox) {
        checkbox.checked = true;
      }

      showToast(`Documento Validado! ${parsedJson.feedback}`, "success");

      // 2. Pergunta ao usuário se deseja auto-preencher as informações do cliente
      const extracted = parsedJson.dados_extraidos;
      const clientObj = AppState.clients.find(c => c.id === clientId);

      if (clientObj && (extracted.cpf || extracted.endereco)) {
        const confirmMsg = `O Scan IA extraiu os seguintes dados:\n` +
          (extracted.nome ? `- Nome: ${extracted.nome}\n` : '') +
          (extracted.cpf ? `- CPF: ${extracted.cpf}\n` : '') +
          (extracted.endereco ? `- Endereço: ${extracted.endereco}\n` : '') +
          `\nDeseja atualizar a ficha de cadastro do cliente no Supabase agora?`;

        if (confirm(confirmMsg)) {
          // Atualiza dados no banco/cache
          const updates = {};
          if (extracted.cpf) updates.document = extracted.cpf;
          if (extracted.endereco) updates.phone = clientObj.phone; // Keep phone, we don't have separate address column, wait, in clients:
          // Let's check which fields clients table has: name, document, email, phone, is_active.
          // Wait! Since there is no "address" column in clients table, we can just save the extracted CPF/document into the document column!
          // And we can show the extracted address to the user in a toast or let them copy it!
          
          if (extracted.cpf) {
            clientObj.document = extracted.cpf;
            // Saves client updates via Supabase if possible
            if (isSupabaseConfigured() && AppState.session) {
              const { error } = await supabaseClient
                .from('clients')
                .update({ document: extracted.cpf })
                .eq('id', clientId);
              
              if (error) throw error;
            }
            renderClientsTable();
            showToast("Cadastro de cliente atualizado com CPF extraído pela IA!", "success");
          }
          
          if (extracted.endereco) {
            // Address is copied to clipboard as helper
            navigator.clipboard.writeText(extracted.endereco);
            showToast("Endereço extraído copiado para área de transferência! Cole onde desejar.", "info");
          }
        }
      }

    } else {
      showToast(`Documento Recusado: ${parsedJson.feedback}`, "warning");
    }

  } catch (error) {
    console.error("Erro no processamento do documento:", error);
    showToast("Erro ao processar Scan IA: " + error.message, "error");
  } finally {
    if (loader) loader.style.display = 'none';
  }
}

window.copyInviteLink = function(role) {
  if (!AppState.userProfile || !AppState.userProfile.tenant_id) {
    showToast("Erro: Você precisa estar logado para gerar o link de convite.", "error");
    return;
  }
  
  const inviteUrl = `${window.location.origin}/convite.html?tenant_id=${AppState.userProfile.tenant_id}&role=${role}`;
  navigator.clipboard.writeText(inviteUrl);
  
  const roleNames = {
    associate: 'Advogado Parceiro',
    financial: 'Assessor Jurídico',
    secretary: 'Secretária'
  };
  const roleName = roleNames[role] || 'Membro';
  showToast(`Link de convite para ${roleName} copiado para a área de transferência!`, "success");
};

// =========================================================================
// 10. MÓDULO DE AGENDA & COMPROMISSOS (AgendaTab)
// =========================================================================

/**
 * Inicializa a aba de Agenda
 */
async function initAgendaTab() {
  const role = AppState.userProfile?.role;
  const isOwnerOrSecretary = (role === 'owner' || role === 'partner' || role === 'secretary');

  // Controle de exibição do formulário de criação (somente Dono e Secretária cadastram)
  const formCard = document.getElementById('agendaFormCard');
  const layoutGrid = document.getElementById('agendaLayoutGrid');

  if (formCard && layoutGrid) {
    if (isOwnerOrSecretary) {
      formCard.style.display = '';
      layoutGrid.style.gridTemplateColumns = '1fr 2fr';
    } else {
      formCard.style.display = 'none';
      layoutGrid.style.gridTemplateColumns = '1fr';
    }
  }

  // Popula o select de Responsável
  const assigneeSelect = document.getElementById('agendaAssignee');
  assigneeSelect.innerHTML = '<option value="">Selecione um advogado...</option>';
  
  if (AppState.members && AppState.members.length > 0) {
    AppState.members.forEach(member => {
      assigneeSelect.innerHTML += `<option value="${member.full_name}">${member.full_name}</option>`;
    });
  } else if (AppState.userProfile) {
    assigneeSelect.innerHTML += `<option value="${AppState.userProfile.full_name}">${AppState.userProfile.full_name}</option>`;
  }

  // Popula o select de Clientes
  const clientSelect = document.getElementById('agendaClient');
  clientSelect.innerHTML = '<option value="">Selecione um cliente (opcional)...</option>';
  AppState.clients.forEach(c => {
    clientSelect.innerHTML += `<option value="${c.id}">${c.name}</option>`;
  });

  // Popula o select de Processos
  const caseSelect = document.getElementById('agendaCase');
  caseSelect.innerHTML = '<option value="">Selecione um caso (opcional)...</option>';
  AppState.cases.forEach(c => {
    caseSelect.innerHTML += `<option value="${c.id}">${c.title} (${c.case_number || 'Sem número'})</option>`;
  });

  // Preenche a data/hora de início com a hora atual + 1 hora
  const startAtInput = document.getElementById('agendaStartAt');
  if (!startAtInput.value) {
    const now = new Date();
    now.setHours(now.getHours() + 1);
    now.setMinutes(0);
    // Ajusta formato YYYY-MM-DDTHH:MM
    const offset = now.getTimezoneOffset();
    const localNow = new Date(now.getTime() - (offset * 60 * 1000));
    startAtInput.value = localNow.toISOString().slice(0, 16);
  }

  // Carrega e renderiza os dados
  showLoader(true);
  try {
    AppState.appointments = await getAppointments();
  } catch (err) {
    showToast("Erro ao carregar agenda: " + err.message, "error");
  } finally {
    showLoader(false);
  }

  renderAppointmentsList();
}

/**
 * Cadastra um novo compromisso na Agenda
 */
async function addAppointment() {
  const title = document.getElementById('agendaTitle').value.trim();
  const startAt = document.getElementById('agendaStartAt').value;
  const assigneeName = document.getElementById('agendaAssignee').value;
  const clientId = document.getElementById('agendaClient').value || null;
  const caseId = document.getElementById('agendaCase').value || null;
  const description = document.getElementById('agendaDescription').value.trim() || '';

  if (!title || !startAt || !assigneeName) {
    showToast("Preencha todos os campos obrigatórios.", "warning");
    return;
  }

  const tenantId = AppState.userProfile?.tenant_id;
  if (!tenantId) return;

  // Busca ID do responsável se estiver na lista de members
  const member = AppState.members.find(m => m.full_name === assigneeName);
  const assigneeId = member ? member.id : null;

  showLoader(true);
  try {
    const newAppointment = await createAppointment(tenantId, {
      title,
      start_at: new Date(startAt).toISOString(),
      assignee_id: assigneeId,
      assignee_name: assigneeName,
      client_id: clientId,
      case_id: caseId,
      description,
      created_by: AppState.userProfile.id
    });

    if (newAppointment) {
      AppState.appointments.push(newAppointment);
      showToast("Compromisso agendado com sucesso!", "success");
      document.getElementById('agendaForm').reset();
      
      // Carrega atualizado do banco
      AppState.appointments = await getAppointments();
      renderAppointmentsList();
    }
  } catch (err) {
    showToast("Erro ao salvar compromisso: " + err.message, "error");
  } finally {
    showLoader(false);
  }
}

/**
 * Deleta um compromisso da agenda
 */
async function handleDeleteAppointment(appointmentId) {
  if (!confirm("Deseja realmente excluir este compromisso?")) return;

  showLoader(true);
  try {
    await deleteAppointment(appointmentId);
    AppState.appointments = AppState.appointments.filter(a => a.id !== appointmentId);
    showToast("Compromisso cancelado/removido.", "info");
    renderAppointmentsList();
  } catch (err) {
    showToast("Erro ao remover compromisso: " + err.message, "error");
  } finally {
    showLoader(false);
  }
}

/**
 * Renderiza a lista de compromissos no container com filtros
 */
function renderAppointmentsList() {
  const container = document.getElementById('appointmentsListContainer');
  if (!container) return;

  const search = document.getElementById('searchAgenda').value.toLowerCase();
  const filterDate = document.getElementById('filterAgendaDate').value;

  const role = AppState.userProfile?.role;
  const userFullName = AppState.userProfile?.full_name;
  const isOwnerOrSecretary = (role === 'owner' || role === 'partner' || role === 'secretary');

  let list = AppState.appointments || [];

  // 1. Filtragem para associados: eles só veem compromissos deles mesmos
  if (role === 'associate') {
    list = list.filter(a => normalizeStr(a.assignee_name) === normalizeStr(userFullName));
  }

  // 2. Filtro de Busca por Título ou Responsável
  if (search) {
    list = list.filter(a => 
      a.title.toLowerCase().includes(search) || 
      (a.assignee_name && a.assignee_name.toLowerCase().includes(search))
    );
  }

  // 3. Filtro por data (Hoje, Esta Semana, Todos)
  const today = new Date();
  const todayStr = today.toLocaleDateString('en-CA'); // YYYY-MM-DD

  if (filterDate === 'today') {
    list = list.filter(a => {
      const aDate = new Date(a.start_at).toLocaleDateString('en-CA');
      return aDate === todayStr;
    });
  } else if (filterDate === 'week') {
    // Próximos 7 dias
    const nextWeek = new Date();
    nextWeek.setDate(today.getDate() + 7);
    list = list.filter(a => {
      const aTime = new Date(a.start_at).getTime();
      return aTime >= today.setHours(0,0,0,0) && aTime <= nextWeek.setHours(23,59,59,999);
    });
  }

  container.innerHTML = '';

  if (list.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; color: var(--text-muted); padding: 40px;">
        📅 Nenhum compromisso agendado para o período selecionado.
      </div>
    `;
    return;
  }

  // Ordena cronologicamente por hora de início
  const sorted = [...list].sort((a, b) => new Date(a.start_at) - new Date(b.start_at));

  sorted.forEach(ap => {
    const startDate = new Date(ap.start_at);
    const dateStr = startDate.toLocaleDateString('pt-BR');
    const timeStr = startDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    
    const isToday = startDate.toLocaleDateString('en-CA') === todayStr;
    const isPast = startDate < new Date() && !isToday;

    let timeBadgeColor = 'var(--text-muted)';
    let timeBadgeBg = 'rgba(0,0,0,0.04)';
    let statusText = 'Agendado';

    if (isToday) {
      timeBadgeColor = 'var(--primary)';
      timeBadgeBg = 'var(--primary-light)';
      statusText = 'Hoje ⏳';
    } else if (isPast) {
      timeBadgeColor = 'var(--danger)';
      timeBadgeBg = '#ffebee';
      statusText = 'Realizado / Passado';
    }

    const clientName = ap.clients?.name || 'Sem cliente vinculado';
    const caseTitle = ap.cases?.title || 'Sem processo vinculado';
    const assignee = ap.user_profiles?.full_name || ap.assignee_name || 'Não atribuído';

    const deleteBtn = isOwnerOrSecretary
      ? `<button onclick="handleDeleteAppointment('${ap.id}')" style="background: none; border: none; color: var(--danger); cursor: pointer; padding: 4px; display: flex; align-items: center; justify-content: center; opacity: 0.7; transition: var(--transition);" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.7" title="Desmarcar / Remover">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
            <line points="18 6 6 18"></line>
            <line points="6 6 18 18"></line>
          </svg>
        </button>`
      : '';

    container.innerHTML += `
      <div class="onboarding-step-card" style="display: flex; justify-content: space-between; align-items: flex-start; padding: 16px; border: 1.5px solid var(--border-color); border-radius: var(--radius); background: #fff; box-shadow: var(--shadow-sm); transition: var(--transition);">
        <div style="display: flex; gap: 14px; align-items: flex-start;">
          
          <!-- Badge de Data/Hora -->
          <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; width: 70px; padding: 8px; border-radius: 6px; background: ${timeBadgeBg}; color: ${timeBadgeColor}; text-align: center;">
            <span style="font-size: 0.75rem; font-weight: 700; text-transform: uppercase;">${dateStr.slice(0, 5)}</span>
            <span style="font-size: 1.1rem; font-weight: 800; margin-top: 2px;">${timeStr}</span>
          </div>

          <!-- Informações do Agendamento -->
          <div style="display: flex; flex-direction: column; gap: 4px;">
            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
              <h4 style="margin: 0; font-size: 0.95rem; font-weight: 700; color: var(--text-dark);">${ap.title}</h4>
              <span class="badge" style="font-size: 0.65rem; background: ${timeBadgeBg}; color: ${timeBadgeColor}; font-weight: 700; border: none; padding: 2px 6px;">${statusText}</span>
            </div>
            
            <p style="margin: 0; font-size: 0.8rem; color: var(--text-muted); line-height: 1.4;">
              ${ap.description || 'Sem observações adicionais.'}
            </p>

            <div style="display: flex; gap: 14px; align-items: center; margin-top: 6px; flex-wrap: wrap; font-size: 0.75rem; color: var(--text-muted);">
              <span>👤 <strong>Advogado:</strong> ${assignee}</span>
              <span>🏢 <strong>Cliente:</strong> ${clientName}</span>
              <span>⚖️ <strong>Caso:</strong> ${caseTitle}</span>
            </div>
          </div>

        </div>

        <!-- Ação de Deletar (apenas dono/secretaria) -->
        ${deleteBtn}
      </div>
    `;
  });
}

// =========================================================================
// 11. MÓDULO DE CONFIGURAÇÃO DE ONBOARDING & IDENTIDADE VISUAL
// =========================================================================

let onboardingStep = 1;
let wizardLogoBase64 = null;
let wizardPixQRBase64 = null;

let settingsLogoBase64 = null;
let settingsPixQRBase64 = null;

// Controla a exibição do overlay de Onboarding
function showOnboardingWizard(show) {
  const overlay = document.getElementById('onboardingWizardOverlay');
  if (!overlay) return;

  if (show) {
    overlay.style.display = 'flex';
    onboardingStep = 1;
    wizardLogoBase64 = null;
    wizardPixQRBase64 = null;
    
    // Reseta form do wizard se existir
    const form = document.getElementById('onboardingWizardForm');
    if (form) form.reset();
    
    const logoContainer = document.getElementById('wizardLogoPreviewContainer');
    if (logoContainer) logoContainer.style.display = 'none';
    
    const qrContainer = document.getElementById('wizardPixQRPreviewContainer');
    if (qrContainer) qrContainer.style.display = 'none';
    
    const pCode = document.getElementById('wizardPrimaryColorCode');
    if (pCode) pCode.textContent = '#E84C0B';
    
    const sCode = document.getElementById('wizardSecondaryColorCode');
    if (sCode) sCode.textContent = '#F97316';

    updateOnboardingWizardUI();
  } else {
    overlay.style.display = 'none';
  }
}

function updateOnboardingWizardUI() {
  document.querySelectorAll('.onboarding-step-pane').forEach(p => p.style.display = 'none');
  const activePane = document.getElementById(`onboarding-step-${onboardingStep}`);
  if (activePane) activePane.style.display = 'flex';

  const indicator = document.getElementById('onboardingStepIndicator');
  if (indicator) indicator.textContent = `${onboardingStep} / 3`;

  const bar = document.getElementById('onboardingProgressBar');
  if (bar) bar.style.width = `${onboardingStep * 33.3}%`;

  const btnPrev = document.getElementById('btnOnboardingPrev');
  if (btnPrev) btnPrev.style.visibility = onboardingStep === 1 ? 'hidden' : 'visible';

  const btnNext = document.getElementById('btnOnboardingNext');
  if (btnNext) btnNext.textContent = onboardingStep === 3 ? 'Concluir 🎉' : 'Avançar ▶';
}

window.changeOnboardingStep = function(dir) {
  const newStep = onboardingStep + dir;
  if (newStep >= 1 && newStep <= 3) {
    onboardingStep = newStep;
    updateOnboardingWizardUI();
  }
};

window.handleOnboardingNext = function() {
  if (onboardingStep < 3) {
    const activePane = document.getElementById(`onboarding-step-${onboardingStep}`);
    const requiredInputs = activePane.querySelectorAll('input[required]');
    let valid = true;
    requiredInputs.forEach(input => {
      if (!input.value.trim()) {
        valid = false;
        input.style.borderColor = 'var(--danger)';
      } else {
        input.style.borderColor = 'var(--border-color)';
      }
    });

    if (!valid) {
      showToast("Preencha todos os campos obrigatórios para avançar.", "warning");
      return;
    }
    window.changeOnboardingStep(1);
  } else {
    saveOnboardingData();
  }
};

window.applyQuickPalette = function(primary, secondary) {
  document.getElementById('wizardPrimaryColor').value = primary;
  document.getElementById('wizardSecondaryColor').value = secondary;
  document.getElementById('wizardPrimaryColorCode').textContent = primary;
  document.getElementById('wizardSecondaryColorCode').textContent = secondary;
};

async function saveOnboardingData() {
  const activePane = document.getElementById('onboarding-step-3');
  const requiredInputs = activePane.querySelectorAll('input[required]');
  let valid = true;
  requiredInputs.forEach(input => {
    if (!input.value.trim()) {
      valid = false;
      input.style.borderColor = 'var(--danger)';
    } else {
      input.style.borderColor = 'var(--border-color)';
    }
  });

  if (!valid) {
    showToast("Preencha todos os campos obrigatórios para concluir.", "warning");
    return;
  }

  showLoader(true);
  try {
    const payload = {
      office_name: document.getElementById('wizardOfficeName').value.trim(),
      responsible_lawyer: document.getElementById('wizardResponsibleLawyer').value.trim(),
      phone: document.getElementById('wizardPhone').value.trim() || null,
      email: document.getElementById('wizardEmail').value.trim() || null,
      address: document.getElementById('wizardAddress').value.trim() || null,
      primary_color: document.getElementById('wizardPrimaryColor').value,
      secondary_color: document.getElementById('wizardSecondaryColor').value,
      logo_base64: wizardLogoBase64 || null,
      bank_name: document.getElementById('wizardBankName').value.trim(),
      beneficiary_name: document.getElementById('wizardBeneficiaryName').value.trim(),
      pix_key: document.getElementById('wizardPixKey').value.trim(),
      pix_qr_base64: wizardPixQRBase64 || null,
      onboarding_completed: true
    };

    const saved = await updateOfficeSettings(AppState.userProfile.tenant_id, payload);
    AppState.officeSettings = saved;
    applyOfficeTheme(saved);
    showToast("Escritório configurado com sucesso!", "success");
    
    showOnboardingWizard(false);
    initBillingGeneratorTab();
  } catch (err) {
    showToast("Erro ao salvar configurações do onboarding: " + err.message, "error");
  } finally {
    showLoader(false);
  }
}

// Inicializa a aba de configurações
function initOfficeSettingsTab() {
  const settings = AppState.officeSettings;
  if (!settings) return;

  document.getElementById('settingsOfficeName').value = settings.office_name || '';
  document.getElementById('settingsResponsibleLawyer').value = settings.responsible_lawyer || '';
  document.getElementById('settingsPhone').value = settings.phone || '';
  document.getElementById('settingsEmail').value = settings.email || '';
  document.getElementById('settingsAddress').value = settings.address || '';
  
  document.getElementById('settingsPrimaryColor').value = settings.primary_color || '#E84C0B';
  document.getElementById('settingsSecondaryColor').value = settings.secondary_color || '#F97316';
  document.getElementById('settingsPrimaryColorCode').textContent = (settings.primary_color || '#E84C0B').toUpperCase();
  document.getElementById('settingsSecondaryColorCode').textContent = (settings.secondary_color || '#F97316').toUpperCase();

  settingsLogoBase64 = settings.logo_base64;
  if (settings.logo_base64) {
    document.getElementById('settingsLogoPreview').src = settings.logo_base64;
    document.getElementById('settingsLogoPreviewContainer').style.display = 'flex';
  } else {
    document.getElementById('settingsLogoPreviewContainer').style.display = 'none';
  }

  document.getElementById('settingsBankName').value = settings.bank_name || '';
  document.getElementById('settingsBeneficiaryName').value = settings.beneficiary_name || '';
  document.getElementById('settingsPixKey').value = settings.pix_key || '';

  settingsPixQRBase64 = settings.pix_qr_base64;
  if (settings.pix_qr_base64) {
    document.getElementById('settingsPixQRPreview').src = settings.pix_qr_base64;
    document.getElementById('settingsPixQRPreviewContainer').style.display = 'flex';
  } else {
    document.getElementById('settingsPixQRPreviewContainer').style.display = 'none';
  }

  // Carrega chave do Gemini do localStorage
  const geminiKeyEl = document.getElementById('settingsGeminiKey');
  if (geminiKeyEl) {
    geminiKeyEl.value = localStorage.getItem('advcontrol_gemini_api_key') || '';
  }
}

window.removeSettingsLogo = function() {
  settingsLogoBase64 = null;
  document.getElementById('settingsLogoPreviewContainer').style.display = 'none';
  document.getElementById('settingsLogo').value = '';
};

window.removeSettingsPixQR = function() {
  settingsPixQRBase64 = null;
  document.getElementById('settingsPixQRPreviewContainer').style.display = 'none';
  document.getElementById('settingsPixQR').value = '';
};

window.saveOfficeSettingsForm = async function() {
  const tenantId = AppState.userProfile?.tenant_id;
  if (!tenantId) return;

  showLoader(true);
  try {
    const payload = {
      office_name: document.getElementById('settingsOfficeName').value.trim(),
      responsible_lawyer: document.getElementById('settingsResponsibleLawyer').value.trim(),
      phone: document.getElementById('settingsPhone').value.trim() || null,
      email: document.getElementById('settingsEmail').value.trim() || null,
      address: document.getElementById('settingsAddress').value.trim() || null,
      primary_color: document.getElementById('settingsPrimaryColor').value,
      secondary_color: document.getElementById('settingsSecondaryColor').value,
      logo_base64: settingsLogoBase64 || null,
      bank_name: document.getElementById('settingsBankName').value.trim(),
      beneficiary_name: document.getElementById('settingsBeneficiaryName').value.trim(),
      pix_key: document.getElementById('settingsPixKey').value.trim(),
      pix_qr_base64: settingsPixQRBase64 || null,
      onboarding_completed: true
    };

    const saved = await updateOfficeSettings(tenantId, payload);
    AppState.officeSettings = saved;
    applyOfficeTheme(saved);
    
    // Grava chave do Gemini no localStorage
    const geminiKeyInput = document.getElementById('settingsGeminiKey');
    if (geminiKeyInput) {
      localStorage.setItem('advcontrol_gemini_api_key', geminiKeyInput.value.trim());
    }

    showToast("Configurações do escritório atualizadas!", "success");
    initBillingGeneratorTab();
  } catch (err) {
    showToast("Erro ao salvar: " + err.message, "error");
  } finally {
    showLoader(false);
  }
};

// Aplicação de identidade visual em tempo real
function applyOfficeTheme(settings) {
  if (!settings) return;

  if (settings.primary_color) {
    document.documentElement.style.setProperty('--primary', settings.primary_color);
    document.documentElement.style.setProperty('--primary-hover', adjustColorBrightness(settings.primary_color, -12));
    document.documentElement.style.setProperty('--primary-light', settings.primary_color + '12'); // ~7% opacidade
    document.documentElement.style.setProperty('--primary-gradient', `linear-gradient(135deg, ${settings.primary_color}, ${settings.secondary_color || settings.primary_color})`);
  }

  if (settings.secondary_color) {
    document.documentElement.style.setProperty('--secondary', settings.secondary_color);
    document.documentElement.style.setProperty('--secondary-light', settings.secondary_color + '1a'); // 10% opacidade
  }

  if (settings.logo_base64) {
    const logoIcon = document.querySelector('.logo-icon');
    if (logoIcon) {
      logoIcon.innerHTML = `<img src="${settings.logo_base64}" style="max-height: 38px; max-width: 38px; border-radius: 6px; object-fit: contain;">`;
    }
  }

  if (settings.office_name) {
    const logoText = document.querySelector('.logo-text');
    if (logoText) {
      const name = settings.office_name.length > 18 ? settings.office_name.slice(0, 15) + '...' : settings.office_name;
      logoText.innerHTML = name;
    }
  }
}

function adjustColorBrightness(hex, percent) {
  if (!hex || typeof hex !== 'string' || hex.charAt(0) !== '#' || hex.length !== 7) {
    return hex || '#E84C0B';
  }
  let R = parseInt(hex.substring(1, 3), 16);
  let G = parseInt(hex.substring(3, 5), 16);
  let B = parseInt(hex.substring(5, 7), 16);

  if (isNaN(R) || isNaN(G) || isNaN(B)) {
    return hex;
  }

  R = parseInt((R * (100 + percent)) / 100);
  G = parseInt((G * (100 + percent)) / 100);
  B = parseInt((B * (100 + percent)) / 100);

  R = R < 255 ? R : 255;
  G = G < 255 ? G : 255;
  B = B < 255 ? B : 255;

  R = R > 0 ? R : 0;
  G = G > 0 ? G : 0;
  B = B > 0 ? B : 0;

  const rHex = R.toString(16).padStart(2, '0');
  const gHex = G.toString(16).padStart(2, '0');
  const bHex = B.toString(16).padStart(2, '0');

  return `#${rHex}${gHex}${bHex}`;
}

// Exposição explícita de funções ao escopo global (window) para compatibilidade com eventos inline
window.openClientForm = openClientForm;
window.handleDeleteClient = handleDeleteClient;
window.openClientDocChecklistModal = openClientDocChecklistModal;
window.openSplitRulesModal = openSplitRulesModal;
window.openCaseAIModal = openCaseAIModal;
window.openLegalDraftModal = openLegalDraftModal;
window.openCaseForm = openCaseForm;
window.handleDeleteCase = handleDeleteCase;
window.handleDeleteOrgTask = handleDeleteOrgTask;
window.updateOrgTaskStatusSelect = updateOrgTaskStatusSelect;
window.handleDeleteAppointment = handleDeleteAppointment;
window.openMemberForm = openMemberForm;
window.switchTab = switchTab;



