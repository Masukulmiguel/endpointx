(function () {
  const STORAGE_LANG = 'endpointx_lang';
  const STORAGE_THEME = 'endpointx_theme';

  const dict = {
    pt: {
      'nav.how': 'Como funciona',
      'nav.features': 'Funcionalidades',
      'nav.hermes': 'HERMES',
      'nav.docs': 'Documentação',
      'nav.login': 'Entrar',
      'nav.register': 'Começar grátis',
      'nav.creator': 'Criador',
      'hero.eyebrow': 'IAM + Endpoint Management + Defesa',
      'hero.title': 'Veja, proteja e governe cada endpoint da sua rede',
      'hero.lead':
        'EndpointX é uma plataforma defensiva de gestão de identidade, acesso e endpoints — com inventário em tempo real, políticas de conformidade e o motor de inteligência de segurança HERMES.',
      'hero.cta1': 'Criar conta grátis',
      'hero.cta2': 'Entrar na demo',
      'hero.trust1': 'Defensivo por desenho',
      'hero.trust2': 'PT | EN',
      'hero.trust3': 'Open source no GitHub',
      'mock.cpu': 'CPU',
      'mock.ram': 'RAM',
      'mock.disk': 'Disco',
      'mock.alerts': 'Alertas',
      'mock.devices': 'Dispositivos',
      'mock.online': 'Online',
      'mock.events': 'Eventos de segurança',
      'how.title': 'Como funciona',
      'how.sub': 'Do agente ao painel em quatro passos.',
      'how.1.t': 'Instale o agente',
      'how.1.d': 'Instale o agente nos PCs autorizados. O registo é rápido e auditado.',
      'how.2.t': 'Monitorize em tempo real',
      'how.2.d': 'Heartbeats, inventário, processos e estado de rede num só painel.',
      'how.3.t': 'Aplique políticas',
      'how.3.d': 'Grupos, conformidade e controlo de acesso com permissões por função.',
      'how.4.t': 'Defenda com HERMES',
      'how.4.d': 'Descoberta de activos, análise de portas e recomendações com evidência.',
      'arch.title': 'Arquitectura da plataforma',
      'arch.sub': 'Agentes → API → Base de dados → Painel. Claro e auditável.',
      'feat.title': 'Funcionalidades',
      'feat.sub': 'Tudo o que precisa para operar segurança defensiva de ponta a ponta.',
      'feat.1.t': 'Gestão de dispositivos',
      'feat.1.d': 'Inventário, estados online/offline, comandos remotos e isolamento.',
      'feat.1.s': 'available',
      'feat.2.t': 'IAM e permissões',
      'feat.2.d': 'Funções, permissões granulares, MFA e sessões auditadas.',
      'feat.2.s': 'available',
      'feat.3.t': 'Alertas e eventos',
      'feat.3.d': 'Severidade, filtros, resolução e registos de auditoria.',
      'feat.3.s': 'available',
      'feat.4.t': 'Conformidade e software',
      'feat.4.d': 'Políticas de compliance, grupos e deploy de software controlado.',
      'feat.4.s': 'available',
      'feat.5.t': 'HERMES',
      'feat.5.d': 'Motor defensivo de avaliação de risco, portas e vulnerabilidades correlacionadas.',
      'feat.5.s': 'available',
      'feat.6.t': 'NetSentinel / NAC',
      'feat.6.d': 'Descoberta de rede e decisões de acesso de rede controladas.',
      'feat.6.s': 'dev',
      'feat.7.t': 'Relatórios',
      'feat.7.d': 'Exportações e visões operacionais para equipas de segurança.',
      'feat.7.s': 'available',
      'feat.8.t': 'Integrações e conectores',
      'feat.8.d': 'Ligação a SIEM e ferramentas externas em evolução.',
      'feat.8.s': 'planned',
      'hermes.title': 'HERMES — inteligência defensiva',
      'hermes.sub':
        'Host Evaluation Risk Monitoring Engine Security. Observa, analisa e recomenda — nunca explora hosts de forma ofensiva.',
      'hermes.1.t': 'Descoberta de activos',
      'hermes.1.d': 'Sincroniza endpoints autorizados e sinaliza activos desconhecidos para revisão.',
      'hermes.2.t': 'Análise de portas e serviços',
      'hermes.2.d': 'Sondagens TCP não destrutivas, identificação de serviços com confiança e evidência.',
      'hermes.3.t': 'Correlação de vulnerabilidades',
      'hermes.3.d': 'Cruza inventário e superfície de ataque com recomendações accionáveis.',
      'hermes.link': 'Ver documentação HERMES',
      'priv.title': 'Princípios de privacidade e segurança',
      'priv.sub': 'Desenhado para equipas que levam a sério a defesa de endpoints.',
      'priv.1.t': 'Só endpoints autorizados',
      'priv.1.d': 'Só dispositivos registados, com agente e ranges CIDR configurados pelo admin.',
      'priv.2.t': 'Sem recolha invasiva',
      'priv.2.d': 'Sem palavras-passe, keystrokes ou conteúdo de ficheiros.',
      'priv.3.t': 'Evidência e auditoria',
      'priv.3.d': 'Cada conclusão tem fonte, confiança, timestamp e rasto em audit logs.',
      'priv.4.t': 'Aprovação humana',
      'priv.4.d': 'Remediação disruptiva requer aprovação de administrador.',
      'docs.title': 'Documentação',
      'docs.sub': 'Guias técnicos, API e operação.',
      'docs.arch': 'Arquitectura',
      'docs.api': 'API',
      'docs.install': 'Guia de instalação',
      'docs.deploy': 'Deploy',
      'docs.security': 'Segurança',
      'docs.hermes': 'HERMES',
      'cta.title': 'Comece com a free early access',
      'cta.sub': 'Crie a sua conta gratuita e ligue o primeiro endpoint em minutos.',
      'cta.primary': 'Criar conta grátis',
      'cta.secondary': 'Já tenho conta',
      'footer.product': 'Produto',
      'footer.docs': 'Documentação',
      'footer.company': 'Projecto',
      'footer.privacy': 'Privacidade',
      'footer.terms': 'Termos',
      'footer.status': 'Estado do serviço',
      'footer.creator': 'Criado por',
      'footer.rights': 'Todos os direitos reservados.',
      's.available': 'Disponível',
      's.dev': 'Em desenvolvimento',
      's.planned': 'Planeado',
      'login.title': 'Entrar',
      'login.sub': 'Aceda ao painel administrativo EndpointX.',
      'login.email': 'Email',
      'login.password': 'Palavra-passe',
      'login.submit': 'Entrar',
      'login.forgot': 'Esqueceu a palavra-passe?',
      'login.noAccount': 'Ainda não tem conta?',
      'login.create': 'Criar conta grátis',
      'login.back': '← Voltar ao início',
      'login.emailRequired': 'O email é obrigatório.',
      'login.passwordRequired': 'A palavra-passe é obrigatória.',
      'register.title': 'Criar conta',
      'register.sub': 'Free early access — sem cartão de crédito.',
      'register.name': 'Nome completo',
      'register.email': 'Email',
      'register.password': 'Palavra-passe',
      'register.submit': 'Criar conta e entrar',
      'register.haveAccount': 'Já tem conta?',
      'register.login': 'Entrar',
      'register.hint': 'Mín. 12 caracteres, maiúscula, minúscula, número e símbolo.',
      'register.nameRequired': 'O nome é obrigatório.',
      'register.emailInvalid': 'Introduza um email válido.',
      'register.passwordWeak': 'A palavra-passe não cumpre os requisitos.',
      'register.success': 'Conta criada! A redireccionar…',
      'forgot.title': 'Recuperar palavra-passe',
      'forgot.sub': 'Enviaremos um link de redefinição se a conta existir.',
      'forgot.email': 'Email',
      'forgot.submit': 'Enviar link',
      'forgot.sent': 'Se a conta existir, o link foi enviado. Verifique o email (e o spam).',
      'forgot.backLogin': 'Voltar a entrar',
      'common.error': 'Ocorreu um erro.',
      'common.loading': 'A processar…',
      'meta.description':
        'EndpointX — plataforma de IAM, endpoint management e segurança defensiva com HERMES. Gerir dispositivos, alertas, conformidade e inteligência de risco.',
      'meta.title': 'EndpointX — IAM, Endpoint Management e Defesa',
    },
    en: {
      'nav.how': 'How it works',
      'nav.features': 'Features',
      'nav.hermes': 'HERMES',
      'nav.docs': 'Docs',
      'nav.login': 'Sign in',
      'nav.register': 'Start free',
      'nav.creator': 'Creator',
      'hero.eyebrow': 'IAM + Endpoint Management + Defense',
      'hero.title': 'See, protect, and govern every endpoint on your network',
      'hero.lead':
        'EndpointX is a defensive identity, access, and endpoint management platform — real-time inventory, compliance policies, and the HERMES security intelligence engine.',
      'hero.cta1': 'Create free account',
      'hero.cta2': 'Sign in to demo',
      'hero.trust1': 'Defensive by design',
      'hero.trust2': 'PT | EN',
      'hero.trust3': 'Open source on GitHub',
      'mock.cpu': 'CPU',
      'mock.ram': 'RAM',
      'mock.disk': 'Disk',
      'mock.alerts': 'Alerts',
      'mock.devices': 'Devices',
      'mock.online': 'Online',
      'mock.events': 'Security events',
      'how.title': 'How it works',
      'how.sub': 'From agent to dashboard in four steps.',
      'how.1.t': 'Install the agent',
      'how.1.d': 'Install the agent on authorized PCs. Registration is fast and audited.',
      'how.2.t': 'Monitor in real time',
      'how.2.d': 'Heartbeats, inventory, processes, and network status in one dashboard.',
      'how.3.t': 'Apply policies',
      'how.3.d': 'Groups, compliance, and access control with role-based permissions.',
      'how.4.t': 'Defend with HERMES',
      'how.4.d': 'Asset discovery, port analysis, and recommendations with evidence.',
      'arch.title': 'Platform architecture',
      'arch.sub': 'Agents → API → Database → Dashboard. Clear and auditable.',
      'feat.title': 'Features',
      'feat.sub': 'Everything you need to run defensive security end to end.',
      'feat.1.t': 'Device management',
      'feat.1.d': 'Inventory, online/offline state, remote commands, and isolation.',
      'feat.1.s': 'available',
      'feat.2.t': 'IAM and permissions',
      'feat.2.d': 'Roles, granular permissions, MFA, and audited sessions.',
      'feat.2.s': 'available',
      'feat.3.t': 'Alerts and events',
      'feat.3.d': 'Severity, filters, resolution, and audit logs.',
      'feat.3.s': 'available',
      'feat.4.t': 'Compliance and software',
      'feat.4.d': 'Compliance policies, groups, and controlled software deployment.',
      'feat.4.s': 'available',
      'feat.5.t': 'HERMES',
      'feat.5.d': 'Defensive risk engine for ports, assets, and correlated vulnerabilities.',
      'feat.5.s': 'available',
      'feat.6.t': 'NetSentinel / NAC',
      'feat.6.d': 'Network discovery and controlled network access decisions.',
      'feat.6.s': 'dev',
      'feat.7.t': 'Reports',
      'feat.7.d': 'Exports and operational views for security teams.',
      'feat.7.s': 'available',
      'feat.8.t': 'Integrations & connectors',
      'feat.8.d': 'SIEM and external tool integrations in progress.',
      'feat.8.s': 'planned',
      'hermes.title': 'HERMES — defensive intelligence',
      'hermes.sub':
        'Host Evaluation Risk Monitoring Engine Security. Observes, analyzes, and recommends — never offensively exploits hosts.',
      'hermes.1.t': 'Asset discovery',
      'hermes.1.d': 'Syncs authorized endpoints and flags unknown assets for review.',
      'hermes.2.t': 'Port and service analysis',
      'hermes.2.d': 'Non-destructive TCP probes, service identification with confidence and evidence.',
      'hermes.3.t': 'Vulnerability correlation',
      'hermes.3.d': 'Joins inventory and attack surface with actionable recommendations.',
      'hermes.link': 'Read HERMES docs',
      'priv.title': 'Privacy & security principles',
      'priv.sub': 'Built for teams who take endpoint defense seriously.',
      'priv.1.t': 'Authorized endpoints only',
      'priv.1.d': 'Only registered devices with the agent and admin-configured CIDR ranges.',
      'priv.2.t': 'No invasive collection',
      'priv.2.d': 'No passwords, keystrokes, or file contents.',
      'priv.3.t': 'Evidence and audit',
      'priv.3.d': 'Every conclusion has source, confidence, timestamp, and audit trail.',
      'priv.4.t': 'Human approval',
      'priv.4.d': 'Disruptive remediation requires administrator approval.',
      'docs.title': 'Documentation',
      'docs.sub': 'Technical guides, API, and operations.',
      'docs.arch': 'Architecture',
      'docs.api': 'API',
      'docs.install': 'Install guide',
      'docs.deploy': 'Deployment',
      'docs.security': 'Security',
      'docs.hermes': 'HERMES',
      'cta.title': 'Start with free early access',
      'cta.sub': 'Create a free account and connect your first endpoint in minutes.',
      'cta.primary': 'Create free account',
      'cta.secondary': 'I already have an account',
      'footer.product': 'Product',
      'footer.docs': 'Documentation',
      'footer.company': 'Project',
      'footer.privacy': 'Privacy',
      'footer.terms': 'Terms',
      'footer.status': 'Service status',
      'footer.creator': 'Created by',
      'footer.rights': 'All rights reserved.',
      's.available': 'Available',
      's.dev': 'In development',
      's.planned': 'Planned',
      'login.title': 'Sign in',
      'login.sub': 'Access the EndpointX admin dashboard.',
      'login.email': 'Email',
      'login.password': 'Password',
      'login.submit': 'Sign in',
      'login.forgot': 'Forgot password?',
      'login.noAccount': "Don't have an account?",
      'login.create': 'Create free account',
      'login.back': '← Back to home',
      'login.emailRequired': 'Email is required.',
      'login.passwordRequired': 'Password is required.',
      'register.title': 'Create account',
      'register.sub': 'Free early access — no credit card.',
      'register.name': 'Full name',
      'register.email': 'Email',
      'register.password': 'Password',
      'register.submit': 'Create account & sign in',
      'register.haveAccount': 'Already have an account?',
      'register.login': 'Sign in',
      'register.hint': 'Min 12 chars, uppercase, lowercase, number, and symbol.',
      'register.nameRequired': 'Full name is required.',
      'register.emailInvalid': 'Enter a valid email.',
      'register.passwordWeak': 'Password does not meet requirements.',
      'register.success': 'Account created! Redirecting…',
      'forgot.title': 'Reset password',
      'forgot.sub': 'We will send a reset link if the account exists.',
      'forgot.email': 'Email',
      'forgot.submit': 'Send link',
      'forgot.sent': 'If the account exists, the link was sent. Check your inbox (and spam).',
      'forgot.backLogin': 'Back to sign in',
      'common.error': 'Something went wrong.',
      'common.loading': 'Working…',
      'meta.description':
        'EndpointX — defensive IAM, endpoint management, and security platform with HERMES. Manage devices, alerts, compliance, and risk intelligence.',
      'meta.title': 'EndpointX — IAM, Endpoint Management & Defense',
    },
  };

  function getLang() {
    const saved = localStorage.getItem(STORAGE_LANG);
    if (saved === 'pt' || saved === 'en') return saved;
    return (navigator.language || '').toLowerCase().startsWith('pt') ? 'pt' : 'en';
  }

  function setLang(lang) {
    localStorage.setItem(STORAGE_LANG, lang);
    applyLang(lang);
  }

  function t(key, lang) {
    const active = lang || getLang();
    return (dict[active] && dict[active][key]) || dict.en[key] || key;
  }

  function applyLang(lang) {
    const active = lang || getLang();
    document.documentElement.lang = active;

    document.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.getAttribute('data-i18n'), active);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder'), active));
    });
    document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
      el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria'), active));
    });
    document.querySelectorAll('[data-lang-btn]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-lang-btn') === active);
    });

    const title = t('meta.title', active);
    const desc = t('meta.description', active);
    if (document.title) document.title = title;
    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) metaDesc.setAttribute('content', desc);
    const ogDesc = document.querySelector('meta[property="og:description"]');
    if (ogDesc) ogDesc.setAttribute('content', desc);
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle) ogTitle.setAttribute('content', title);
  }

  function getThemePref() {
    return localStorage.getItem(STORAGE_THEME) || 'system';
  }

  function resolveTheme(pref) {
    if (pref === 'light' || pref === 'dark') return pref;
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  function applyTheme(pref) {
    const p = pref || getThemePref();
    const resolved = resolveTheme(p);
    document.documentElement.setAttribute('data-theme', resolved);
    document.querySelectorAll('[data-theme-btn]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.getAttribute('data-theme-btn') === p));
    });
  }

  function setTheme(pref) {
    localStorage.setItem(STORAGE_THEME, pref);
    applyTheme(pref);
  }

  function cycleTheme() {
    const order = ['system', 'light', 'dark'];
    const idx = order.indexOf(getThemePref());
    setTheme(order[(idx + 1) % order.length]);
  }

  function bindCommonControls() {
    document.querySelectorAll('[data-lang-btn]').forEach((btn) => {
      btn.addEventListener('click', () => setLang(btn.getAttribute('data-lang-btn')));
    });
    document.querySelectorAll('[data-theme-btn]').forEach((btn) => {
      btn.addEventListener('click', cycleTheme);
    });
  }

  window.EndpointXSite = {
    getLang,
    setLang,
    t,
    applyLang,
    getThemePref,
    setTheme,
    applyTheme,
    bindCommonControls,
    DASHBOARD_URL: 'https://endpointx-dashboard.onrender.com',
    API_BASE: '/api',
  };

  document.addEventListener('DOMContentLoaded', () => {
    applyLang();
    applyTheme();
    bindCommonControls();
  });
})();
