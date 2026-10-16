(function () {
  const STORAGE_LANG = 'endpointx_lang';
  const STORAGE_THEME = 'endpointx_theme';

  const dict = {
    pt: {
      'nav.platform': 'Plataforma',
      'nav.security': 'Segurança',
      'nav.hermes': 'HERMES',
      'nav.features': 'Funcionalidades',
      'nav.docs': 'Documentação',
      'nav.about': 'Sobre o projecto',
      'nav.login': 'Entrar',
      'nav.register': 'Aceder à plataforma',
      'nav.contact': 'Contacto',

      'hero.badge': 'Monitorização · Gestão · Segurança',
      'hero.title': 'Veja, proteja e governe cada endpoint da sua rede',
      'hero.lead':
        'EndpointX reúne descoberta de dispositivos, gestão de endpoints e análise de segurança numa só plataforma defensiva — com inventário em tempo real, políticas de conformidade e o motor HERMES.',
      'hero.cta1': 'Conhecer a plataforma',
      'hero.cta2': 'Explorar funcionalidades',
      'hero.cta3': 'Aceder à plataforma',
      'hero.trust1': 'Defensivo por desenho',
      'hero.trust2': 'PT e EN',
      'hero.trust3': 'Versão 1.3.0 · em desenvolvimento contínuo',
      'hero.chipA': 'Dispositivos online',
      'hero.chipB': 'Heartbeats recebidos',

      'feat.eyebrow': 'Funcionalidades',
      'feat.title': 'Uma plataforma, do inventário à decisão',
      'feat.lead':
        'Cada capacidade resolve um problema real de equipas de TI e de segurança — está identificada a que já está disponível e a que ainda está em construção.',
      'split1.k': 'Network Discovery',
      'split1.t': 'Descubra o que existe na rede, antes de instalar qualquer agente',
      'split1.d':
        'A descoberta varre os intervalos CIDR que o administrador autorizar, identifica hosts, serviços e fabricantes e apresenta tudo numa fila de revisão. Nada entra sozinho: cada nó é aprovado, ignorado ou enviado para instalação pelo equipa.',
      'split1.l1': 'Runs com intervalos, portas e políticas configuráveis',
      'split1.l2': 'Nós com estado, fabricante (MAC/OUI) e histórico de primeira/última vista',
      'split1.l3': 'Decisões de acesso de rede (NAC) em desenvolvimento',
      'split2.k': 'Endpoint Management',
      'split2.t': 'Inventário, estado e controlo remoto de cada endpoint',
      'split2.d':
        'Com o agente instalado, cada dispositivo reporta inventário completo — software, serviços, processos, partições, interfaces — e mantém um heartbeat contínuo. O painel mostra quem está online, quem caiu e o que mudou.',
      'split2.l1': 'Comandos remotos, bloqueio e isolamento com auditoria',
      'split2.l2': 'Relatórios e exportações para equipas de segurança',
      'split2.l3': 'Deploy de software e conformidade por políticas',

      'cap.1.t': 'Device Enrollment',
      'cap.1.d':
        'Registo de PCs por token de enrolamento e de telemóveis por página PWA — cada dispositivo entra como PENDING até aprovação (Zero Trust).',
      'cap.2.t': 'Monitorização e estado',
      'cap.2.d':
        'Heartbeats com limiares configuráveis, alertas de offline e eventos de segurança em tempo real, com socket.io no painel.',
      'cap.3.t': 'Análise de vulnerabilidades',
      'cap.3.d':
        'Correlação de CVEs com o inventário real dos activos, pontuação de risco e recomendações com evidência.',
      'cap.4.t': 'Security Monitoring',
      'cap.4.d':
        'Alertas com severidade, regras, incidentes e registos de auditoria — tudo consultável e filtrável no painel.',
      'cap.5.t': 'Controlo de acesso e auditoria',
      'cap.5.d':
        'Funções e permissões granulares, MFA, sessões auditadas e revogação efectiva no logout.',
      'cap.6.t': 'NetSentinel / NAC',
      'cap.6.d':
        'Decisões de acesso de rede e políticas NAC por dispositivo — módulo em evolução dentro da área de rede.',
      'cap.available': 'Disponível',
      'cap.dev': 'Em desenvolvimento',

      'plat.eyebrow': 'A plataforma em operação',
      'plat.title': 'Um fluxo real, do descobrimento à decisão',
      'plat.lead':
        'Estas são capturas do painel EndpointX em uso — não maquetas. O mesmo fluxo que vai usar: descobrir, inventariar, analisar.',
      'plat.s1.t': 'Descobrir',
      'plat.s1.d': 'A rede varrida aparece com hosts, serviços e estados — pronto para revisão.',
      'plat.s2.t': 'Inventariar',
      'plat.s2.d': 'O inventário por dispositivo: software, processos, partições e saúde em tempo real.',
      'plat.s3.t': 'Analisar',
      'plat.s3.d': 'HERMES correlaciona evidências e apresenta risco com recomendações accionáveis.',
      'plat.cap1': 'Visão geral do dashboard',
      'plat.cap2': 'Inventário e saúde dos endpoints',
      'plat.cap3': 'HERMES — inteligência defensiva',

      'hermes.eyebrow': 'HERMES Security Intelligence',
      'hermes.title': 'Evidência primeiro, recomendação sempre',
      'hermes.lead':
        'HERMES (Host Evaluation Risk Monitoring Engine · Security) observa e correlaciona — nunca explora hosts de forma ofensiva. Analisa activos autorizados, cruza inventário com superfície de ataque e devolve risco com fonte, confiança e timestamp.',
      'hermes.s1.k': '01 · Evidência',
      'hermes.s1.t': 'Recolha',
      'hermes.s1.d': 'Activos sincronizados, sondagens TCP não destrutivas e inventário real dos endpoints.',
      'hermes.s2.k': '02 · Correlação',
      'hermes.s2.t': 'Análise',
      'hermes.s2.d': 'Portas, serviços e CVEs cruzados com o que existe de facto em cada máquina.',
      'hermes.s3.k': '03 · Recomendação',
      'hermes.s3.t': 'Decisão',
      'hermes.s3.d': 'Pontuação de risco e recomendações accionáveis; remediação disruptiva exige aprovação humana.',
      'hermes.note':
        'HERMES não detecta «todas as ameaças»: apresenta o que mede, com a evidência que a suporta. Scans respeitam os intervalos CIDR autorizados e podem ser detidos a qualquer momento pelo administrador.',

      'sec.eyebrow': 'Confiança e transparência',
      'sec.title': 'Princípios de privacidade e segurança',
      'sec.lead':
        'EndpointX é uma ferramenta defensiva. O que recolhe — e o que nunca recolhe — está explicitado, e o estado real do desenvolvimento não é adornado.',
      'sec.p1.t': 'Só endpoints autorizados',
      'sec.p1.d': 'Só dispositivos registados, com agente e ranges CIDR configurados pelo administrador.',
      'sec.p2.t': 'Sem recolha invasiva',
      'sec.p2.d': 'Sem palavras-passe, keystrokes ou conteúdo de ficheiros.',
      'sec.p3.t': 'Evidência e auditoria',
      'sec.p3.d': 'Cada conclusão tem fonte, confiança, timestamp e rasto nos registos de auditoria.',
      'sec.p4.t': 'Aprovação humana',
      'sec.p4.d': 'Remediação disruptiva requer aprovação de administrador.',
      'sec.status.t': 'Estado do desenvolvimento',
      'sec.status.d':
        'Versão 1.3.0 em early access gratuito. Funcionalidades assinaladas como «em desenvolvimento» ainda não estão prontas — preferimos diz-lo a fingir que estão. Sem clientes, certificações ou números inventados nesta página.',

      'stats.eyebrow': 'Números reais',
      'stats.title': 'A plataforma, em dados',
      'stats.lead':
        'Contadores directos da base de dados, sem valores inventados. Actualiza automaticamente; se a fonte estiver indisponível, mostramos «Dados indisponíveis».',
      'stats.devices': 'Dispositivos registados',
      'stats.online': 'Activos (24 h)',
      'stats.users': 'Utilizadores',
      'stats.downloads': 'Downloads do agente',
      'stats.updated': 'Última actualização',
      'stats.empty': 'Dados indisponíveis',
      'stats.version': 'Versão actual',

      'docs.eyebrow': 'Documentação própria',
      'docs.title': 'Tudo o que precisa, dentro do site',
      'docs.lead':
        'Guias escritos a partir do sistema real — instalação, agentes, descoberta de rede, segurança e perguntas frequentes. Sem saltos para repositórios externos.',
      'docs.d1.t': 'Visão geral da plataforma',
      'docs.d1.d': 'Arquitectura, conceitos e o que cada área do painel faz.',
      'docs.d2.t': 'Instalação e requisitos',
      'docs.d2.d': 'Pré-requisitos, primeiros passos e instalação do agente.',
      'docs.d3.t': 'Gestão de agentes',
      'docs.d3.d': 'Enrolamento, heartbeat, tokens e actualizações.',
      'docs.d4.t': 'Network Discovery',
      'docs.d4.d': 'Intervalos CIDR, revisão de nós e pedidos de instalação.',
      'docs.d5.t': 'Segurança e permissões',
      'docs.d5.d': 'Sessões, MFA, funções, auditoria e protecção de downloads.',
      'docs.d6.t': 'Perguntas frequentes',
      'docs.d6.d': 'Respostas curtas às dúvidas mais comuns.',

      'about.eyebrow': 'Sobre o projecto',
      'about.title': 'EndpointX, pela CodingLife-Dev',
      'about.body':
        'EndpointX é um sistema de gestão de identidade, endpoints e segurança defensiva, construído e mantido pela CodingLife-Dev. O produto está em desenvolvimento activo: esta versão é o early access gratuito 1.3.0, e cada release documenta o que mudou.',
      'about.body2':
        'Dúvidas sobre requisitos, integração ou utilização? A documentação interna cobre o essencial — e o formulário de contacto chega à equipa.',

      'cta.title': 'Comece em minutos',
      'cta.sub':
        'Crie a conta, abra a página «Instalar» no painel e copie o comando já com o seu token — os scripts recusam-se a correr sem ele.',
      'cta.primary': 'Criar conta grátis',
      'cta.secondary': 'Já tenho conta',

      'footer.product': 'Produto',
      'footer.platform': 'Plataforma',
      'footer.project': 'Projecto',
      'footer.about':
        'Gestão de identidade, endpoints e segurança defensiva com HERMES. Early access gratuito.',
      'footer.creator': 'Criado por',
      'footer.rights': 'Todos os direitos reservados.',
      'footer.madeby': 'CodingLife-Dev',

      'contact.title': 'Contacto e suporte',
      'contact.lead': 'Fale connosco sobre requisitos, integração ou problemas na plataforma.',
      'contact.side.t': 'Como tratamos as mensagens',
      'contact.side.d': 'Cada mensagem é registada e lida pela equipa. Não partilhamos os seus dados com terceiros.',
      'contact.side.l1': 'Dúvidas de instalação e configuração',
      'contact.side.l2': 'Problemas de acesso ou funcionamento',
      'contact.side.l3': 'Pedidos de funcionalidades e integrações',
      'contact.name': 'Nome',
      'contact.email': 'Email',
      'contact.message': 'Mensagem',
      'contact.submit': 'Enviar mensagem',
      'contact.success': 'Mensagem enviada. Obrigado — respondemos assim que possível.',
      'contact.required': 'Preencha todos os campos com um email válido.',
      'contact.back': '← Voltar ao início',

      'login.title': 'Entrar',
      'login.sub': 'Aceda ao painel administrativo EndpointX.',
      'login.email': 'Email',
      'login.password': 'Palavra-passe',
      'login.submit': 'Entrar',
      'login.forgot': 'Esqueceu a palavra-passe?',
      'login.noAccount': 'Ainda não tem conta?',
      'login.create': 'Criar conta grátis',
      'login.back': '← Voltar ao início',
      'login.emailRequired': 'Introduza um email válido.',
      'login.passwordRequired': 'Introduza a palavra-passe.',

      'register.title': 'Criar conta',
      'register.sub': 'Comece o early access gratuito do EndpointX.',
      'register.name': 'Nome completo',
      'register.email': 'Email',
      'register.password': 'Palavra-passe',
      'register.submit': 'Criar conta',
      'register.success': 'Conta criada. A encaminhar para o painel…',
      'register.nameRequired': 'Introduza o seu nome.',
      'register.emailInvalid': 'Introduza um email válido.',
      'register.passwordWeak':
        'A palavra-passe precisa de 12+ caracteres com maiúscula, minúscula, número e símbolo.',
      'register.back': '← Voltar ao início',
      'register.haveAccount': 'Já tem conta?',

      'forgot.title': 'Recuperar palavra-passe',
      'forgot.sub': 'Enviaremos um link de recuperação para o seu email.',
      'forgot.email': 'Email',
      'forgot.submit': 'Enviar link',
      'forgot.sent': 'Se o email existir, receberá o link de recuperação.',
      'forgot.back': '← Voltar ao início',

      'common.loading': 'A processar…',
      'common.error': 'Algo correu mal. Tente novamente.',
      'common.lang': 'Idioma',
      'common.theme': 'Alternar tema',
    },
    en: {
      'nav.platform': 'Platform',
      'nav.security': 'Security',
      'nav.hermes': 'HERMES',
      'nav.features': 'Features',
      'nav.docs': 'Documentation',
      'nav.about': 'About the project',
      'nav.login': 'Sign in',
      'nav.register': 'Open the platform',
      'nav.contact': 'Contact',

      'hero.badge': 'Monitoring · Management · Security',
      'hero.title': 'See, protect and govern every endpoint on your network',
      'hero.lead':
        'EndpointX brings device discovery, endpoint management and security analysis into a single defensive platform — with real-time inventory, compliance policies and the HERMES engine.',
      'hero.cta1': 'See the platform',
      'hero.cta2': 'Explore features',
      'hero.cta3': 'Open the platform',
      'hero.trust1': 'Defensive by design',
      'hero.trust2': 'PT and EN',
      'hero.trust3': 'Version 1.3.0 · continuously developed',
      'hero.chipA': 'Devices online',
      'hero.chipB': 'Heartbeats received',

      'feat.eyebrow': 'Features',
      'feat.title': 'One platform, from inventory to decision',
      'feat.lead':
        'Each capability solves a real problem for IT and security teams — clearly marked as available or still under construction.',
      'split1.k': 'Network Discovery',
      'split1.t': 'Discover what is on the network before installing any agent',
      'split1.d':
        'Discovery sweeps the CIDR ranges the administrator authorizes, identifies hosts, services and vendors, and queues everything for review. Nothing joins on its own: every node is approved, ignored or sent for installation by the team.',
      'split1.l1': 'Runs with configurable ranges, ports and policies',
      'split1.l2': 'Nodes with state, vendor (MAC/OUI) and first/last-seen history',
      'split1.l3': 'Network access decisions (NAC) under development',
      'split2.k': 'Endpoint Management',
      'split2.t': 'Inventory, health and remote control of every endpoint',
      'split2.d':
        'With the agent installed, each device reports a full inventory — software, services, processes, partitions, interfaces — and keeps a continuous heartbeat. The panel shows who is online, who dropped and what changed.',
      'split2.l1': 'Remote commands, blocking and isolation with audit trails',
      'split2.l2': 'Reports and exports for security teams',
      'split2.l3': 'Software deployment and policy-based compliance',

      'cap.1.t': 'Device Enrollment',
      'cap.1.d':
        'PCs enroll with a token, mobiles through a PWA page — every device enters as PENDING until approved (Zero Trust).',
      'cap.2.t': 'Monitoring and health',
      'cap.2.d':
        'Heartbeats with configurable thresholds, offline alerts and real-time security events, streamed to the panel.',
      'cap.3.t': 'Vulnerability analysis',
      'cap.3.d':
        'CVE correlation against the real asset inventory, risk scoring and recommendations backed by evidence.',
      'cap.4.t': 'Security Monitoring',
      'cap.4.d':
        'Alerts with severity, rules, incidents and audit records — all searchable and filterable in the panel.',
      'cap.5.t': 'Access control and audit',
      'cap.5.d':
        'Granular roles and permissions, MFA, audited sessions and effective revocation on logout.',
      'cap.6.t': 'NetSentinel / NAC',
      'cap.6.d':
        'Per-device network access decisions and NAC policies — a module evolving inside the network area.',
      'cap.available': 'Available',
      'cap.dev': 'In development',

      'plat.eyebrow': 'The platform at work',
      'plat.title': 'A real flow, from discovery to decision',
      'plat.lead':
        'These are captures of the EndpointX panel in use — not mockups. The same flow you will follow: discover, inventory, analyze.',
      'plat.s1.t': 'Discover',
      'plat.s1.d': 'The swept network appears with hosts, services and states — ready for review.',
      'plat.s2.t': 'Inventory',
      'plat.s2.d': 'Per-device inventory: software, processes, partitions and real-time health.',
      'plat.s3.t': 'Analyze',
      'plat.s3.d': 'HERMES correlates evidence and returns risk with actionable recommendations.',
      'plat.cap1': 'Dashboard overview',
      'plat.cap2': 'Endpoint inventory and health',
      'plat.cap3': 'HERMES — defensive intelligence',

      'hermes.eyebrow': 'HERMES Security Intelligence',
      'hermes.title': 'Evidence first, always a recommendation',
      'hermes.lead':
        'HERMES (Host Evaluation Risk Monitoring Engine · Security) observes and correlates — it never exploits hosts offensively. It analyses authorized assets, cross-references inventory with attack surface and returns risk with source, confidence and timestamp.',
      'hermes.s1.k': '01 · Evidence',
      'hermes.s1.t': 'Collect',
      'hermes.s1.d': 'Synced assets, non-destructive TCP probes and the real endpoint inventory.',
      'hermes.s2.k': '02 · Correlation',
      'hermes.s2.t': 'Analyze',
      'hermes.s2.d': 'Ports, services and CVEs matched against what actually exists on each machine.',
      'hermes.s3.k': '03 · Recommendation',
      'hermes.s3.t': 'Decide',
      'hermes.s3.d': 'Risk scores and actionable recommendations; disruptive remediation requires human approval.',
      'hermes.note':
        'HERMES does not detect “every threat”: it reports what it measures, with the evidence behind it. Scans respect authorized CIDR ranges and can be stopped by the administrator at any time.',

      'sec.eyebrow': 'Trust and transparency',
      'sec.title': 'Privacy and security principles',
      'sec.lead':
        'EndpointX is a defensive tool. What it collects — and what it never collects — is explicit, and the real state of development is not dressed up.',
      'sec.p1.t': 'Authorized endpoints only',
      'sec.p1.d': 'Only registered devices, with the agent and CIDR ranges configured by the administrator.',
      'sec.p2.t': 'No invasive collection',
      'sec.p2.d': 'No passwords, keystrokes or file contents.',
      'sec.p3.t': 'Evidence and audit',
      'sec.p3.d': 'Every conclusion carries source, confidence, timestamp and a trail in the audit logs.',
      'sec.p4.t': 'Human approval',
      'sec.p4.d': 'Disruptive remediation requires administrator approval.',
      'sec.status.t': 'Development status',
      'sec.status.d':
        'Version 1.3.0 in free early access. Features marked “in development” are not ready — we would rather say so than pretend otherwise. No clients, certifications or invented numbers on this page.',

      'stats.eyebrow': 'Real numbers',
      'stats.title': 'The platform, in data',
      'stats.lead':
        'Counters read straight from the database, no invented values. It refreshes automatically; if the source is unavailable we show “Data unavailable”.',
      'stats.devices': 'Registered devices',
      'stats.online': 'Active (24 h)',
      'stats.users': 'Users',
      'stats.downloads': 'Agent downloads',
      'stats.updated': 'Last updated',
      'stats.empty': 'Data unavailable',
      'stats.version': 'Current version',

      'docs.eyebrow': 'Our own documentation',
      'docs.title': 'Everything you need, inside the site',
      'docs.lead':
        'Guides written from the real system — installation, agents, network discovery, security and FAQs. No hops to external repositories.',
      'docs.d1.t': 'Platform overview',
      'docs.d1.d': 'Architecture, concepts and what each area of the panel does.',
      'docs.d2.t': 'Installation and requirements',
      'docs.d2.d': 'Prerequisites, first steps and agent installation.',
      'docs.d3.t': 'Agent management',
      'docs.d3.d': 'Enrollment, heartbeat, tokens and updates.',
      'docs.d4.t': 'Network Discovery',
      'docs.d4.d': 'CIDR ranges, node review and installation requests.',
      'docs.d5.t': 'Security and permissions',
      'docs.d5.d': 'Sessions, MFA, roles, auditing and download protection.',
      'docs.d6.t': 'Frequently asked questions',
      'docs.d6.d': 'Short answers to the most common questions.',

      'about.eyebrow': 'About the project',
      'about.title': 'EndpointX, by CodingLife-Dev',
      'about.body':
        'EndpointX is an identity, endpoint and defensive security system built and maintained by CodingLife-Dev. The product is under active development: this is the 1.3.0 free early access, and every release documents what changed.',
      'about.body2':
        'Questions about requirements, integration or usage? The internal documentation covers the essentials — and the contact form reaches the team.',

      'cta.title': 'Get started in minutes',
      'cta.sub':
        'Create your account, open the “Install” page in the panel and copy the command with your token already in it — the scripts refuse to run without it.',
      'cta.primary': 'Create free account',
      'cta.secondary': 'I already have an account',

      'footer.product': 'Product',
      'footer.platform': 'Platform',
      'footer.project': 'Project',
      'footer.about':
        'Identity, endpoint and defensive security management with HERMES. Free early access.',
      'footer.creator': 'Created by',
      'footer.rights': 'All rights reserved.',
      'footer.madeby': 'CodingLife-Dev',

      'contact.title': 'Contact and support',
      'contact.lead': 'Talk to us about requirements, integration or platform issues.',
      'contact.side.t': 'How we handle messages',
      'contact.side.d': 'Every message is recorded and read by the team. We do not share your data with third parties.',
      'contact.side.l1': 'Installation and configuration questions',
      'contact.side.l2': 'Access or performance issues',
      'contact.side.l3': 'Feature and integration requests',
      'contact.name': 'Name',
      'contact.email': 'Email',
      'contact.message': 'Message',
      'contact.submit': 'Send message',
      'contact.success': 'Message sent. Thank you — we will reply as soon as possible.',
      'contact.required': 'Please fill in all fields with a valid email.',
      'contact.back': '← Back to home',

      'login.title': 'Sign in',
      'login.sub': 'Access the EndpointX admin panel.',
      'login.email': 'Email',
      'login.password': 'Password',
      'login.submit': 'Sign in',
      'login.forgot': 'Forgot your password?',
      'login.noAccount': 'No account yet?',
      'login.create': 'Create free account',
      'login.back': '← Back to home',
      'login.emailRequired': 'Enter a valid email.',
      'login.passwordRequired': 'Enter your password.',

      'register.title': 'Create account',
      'register.sub': 'Start the EndpointX free early access.',
      'register.name': 'Full name',
      'register.email': 'Email',
      'register.password': 'Password',
      'register.submit': 'Create account',
      'register.success': 'Account created. Redirecting to the panel…',
      'register.nameRequired': 'Enter your name.',
      'register.emailInvalid': 'Enter a valid email.',
      'register.passwordWeak':
        'Password needs 12+ characters with uppercase, lowercase, number and symbol.',
      'register.back': '← Back to home',
      'register.haveAccount': 'Already have an account?',

      'forgot.title': 'Reset password',
      'forgot.sub': 'We will send a recovery link to your email.',
      'forgot.email': 'Email',
      'forgot.submit': 'Send link',
      'forgot.sent': 'If the email exists, you will receive the recovery link.',
      'forgot.back': '← Back to home',

      'common.loading': 'Working…',
      'common.error': 'Something went wrong. Please try again.',
      'common.lang': 'Language',
      'common.theme': 'Toggle theme',
    },
  };

  function getLang() {
    const stored = localStorage.getItem(STORAGE_LANG);
    if (stored === 'pt' || stored === 'en') return stored;
    return (navigator.language || '').toLowerCase().startsWith('pt') ? 'pt' : 'en';
  }

  function t(key) {
    const lang = getLang();
    return (dict[lang] && dict[lang][key]) || dict.pt[key] || key;
  }

  function setLang(lang) {
    localStorage.setItem(STORAGE_LANG, lang);
    applyLang();
  }

  function applyLang() {
    const lang = getLang();
    document.documentElement.lang = lang === 'pt' ? 'pt-PT' : 'en';
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const value = t(el.getAttribute('data-i18n'));
      if (value) el.textContent = value;
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      const value = t(el.getAttribute('data-i18n-placeholder'));
      if (value) el.setAttribute('placeholder', value);
    });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => {
      const value = t(el.getAttribute('data-i18n-title'));
      if (value) document.title = value;
    });
    document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
      const value = t(el.getAttribute('data-i18n-aria'));
      if (value) el.setAttribute('aria-label', value);
    });
    document.querySelectorAll('[data-lang-btn]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.getAttribute('data-lang-btn') === lang));
    });
    document.dispatchEvent(new CustomEvent('endpointx:lang', { detail: { lang } }));
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
