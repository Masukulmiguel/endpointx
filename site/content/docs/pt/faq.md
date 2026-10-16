---
title: Perguntas frequentes
lead: Respostas curtas às dúvidas mais comuns.
description: Preço, requisitos, sistemas suportados, telemóveis, offline, dados recolhidos, HERMES, backups, idiomas e suporte do EndpointX.
---

### O EndpointX é pago?

Não. A versão 1.3.0 está em early access gratuito — registe-se e comece a usar sem cartão de crédito.

> **Nota:** é um produto em desenvolvimento activo; as funcionalidades marcadas como «em desenvolvimento» (NAC, deploy de software, feed de CVE) ainda não estão prontas, e preferimos diz-lo a fingir que estão.

### Quais são os requisitos mínimos?

Uma conta, rede com acesso por HTTPS à API e Python no endpoint: 3.8+ em Linux e macOS (3.10+ recomendado nos PCs). No Windows, instale o Python com «Add Python to PATH» marcado — os scripts tratam do resto.

### Que sistemas operativos suportados?

Windows (instalação por PowerShell), Linux Debian/Ubuntu/Fedora e macOS (systemd/launchd) correm o agente Python; Android 8.0+ tem APK e página mobile; iOS usa a página mobile (PWA) com registo e métricas. O guia completo está em [Instalação](/docs/instalacao).

### E os telemóveis?

Abrindo o link `https://endpointx-api-5ypc.onrender.com/api/devices/public/mobile?t=<ENROLL_TOKEN>` (ou o QR code da página **Instalar Agente**). O telemóvel entra como **PENDING** até aprovação no painel (Zero Trust) e a app Android acrescenta ver e controlar o ecrã a distância — no iOS ficam registo, presença e métricas.

### O que acontece se o equipamento ficar offline?

O agente não desinstala nem perde dados: continua a correr localmente e volta a ligar-se sozinho (retentativas com backoff exponencial). No painel, o dispositivo passa a `offline` após 300 segundos sem heartbeat (1800 segundos em telemóveis) e volta a `online` no primeiro heartbeat seguinte; comandos pendentes há mais de 5 minutos passam a `failed`.

### Que dados o agente recolhe?

Inventário (hardware, software, serviços, processos, partições, interfaces), métricas de CPU, memória, disco e rede e o estado de ligação. **Nunca** recolhe palavras-passe, keystrokes nem conteúdo de ficheiros — ver [Segurança](/docs/seguranca).

### O HERMES é uma ferramenta ofensiva?

Não. É segurança defensiva: analisa vulnerabilidades e risco dos equipamentos autorizados e dos intervalos privados configurados (por omissão `192.168.0.0/16`, `10.0.0.0/8`, `172.16.0.0/12` — tudo fora é ignorado). O módulo está em desenvolvimento nesta versão.

### Como parar um scan do HERMES?

Um scan: `POST /api/hermes/scans/:id/stop` (fica `stopped`). Emergência, tudo de uma vez: `POST /api/hermes/emergency-stop` — liga a paragem de emergência (`hermes_emergency_stop`) e pára todos os scans activos; ambos exigem a permissão `hermes.manage` e ficam registados na auditoria.

### Quantas contas de administrador posso ter?

Quantas precisar. O primeiro administrador é criado no arranque (`SEED_ADMIN_PASSWORD`) e o registo gratuito recebe a função `user` (só leitura). Convide quantos quiser com `POST /api/auth/invite` e escolha a função de cada um (admin, supervisor, technician ou user).

### Como faço backup da base de dados?

Com o `pg_dump` (dump em formato custom):

```bash
pg_dump -U endpointx -d endpointx -F c -f backup_$(date +%Y%m%d).dump
pg_restore -U endpointx -d endpointx backup_20250115.dump
```

Guarde os dumps noutra máquina e teste o restauro de vez em quando — um backup que nunca se restaurou não é um backup.

### Em que idiomas está a documentação?

Português e inglês, com a mesma estrutura e conteúdo em ambas as línguas. O seletor no topo do site muda o idioma de toda a página.

### Como contactar o suporte?

Pelo formulário em [/contacto](/contacto) — descreva o problema, o equipamento envolvido e o que já tentou; respondemos por email.

### Onde vejo a documentação completa?

Aqui mesmo, dentro do site: [/docs/visao-geral](/docs/visao-geral) em português e [/en/docs/visao-geral](/en/docs/visao-geral) em inglês. A doc vive no próprio site — sem saltos para repositórios externos.
