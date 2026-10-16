---
title: Segurança e permissões
lead: Sessões, MFA, funções, auditoria e protecção de downloads.
description: Como o EndpointX valida sessões, tokens e MFA, que funções e permissões existem, como auditam as acções e o que os downloads e o agente recolhem.
---

## Sessões e tokens

- **Access token de curta duração** — JWT assinado com o `JWT_ACCESS_SECRET`, validade por omissão de 1 hora (`JWT_EXPIRES_IN`), sempre ligado a uma sessão (`sid` = linha em `user_sessions`). Tokens sem `sid`, expirados ou de sessão revogada são recusados (`AUTH_SESSION_INVALID`, «Invalid session token.»).
- **Refresh token de 7 dias** — guardado apenas como hash SHA-256 em `user_sessions`, rotativo a cada utilização (a renovação estende a validade em 7 dias) e terminado no logout.
- **MFA em passos** — os tokens temporários `mfa_temp` (emitidos no login) nunca passam o gate de sessão: só após `POST /api/auth/mfa-verify` é que sai um token de sessão completo.
- **Bloqueio de conta** — 5 tentativas de login falhadas (`MAX_LOGIN_ATTEMPTS`) bloqueiam a conta durante 15 minutos (`LOCKOUT_DURATION`, 900000 ms); palavras-passe com bcrypt com 12 rondas e mínimo de 12 caracteres com maiúsculas, minúsculas, número e símbolo.
- **Credenciais de agente** — os agentes não usam sessões de administrador: autenticam com o segredo da frota (`X-Agent-Secret`) e, quando aplicável, com o token de enrolamento (30 dias) ou de instalação (7 dias) escrito na configuração.

```json
{
  "sub": "…",
  "role_id": "…",
  "sid": "…",
  "iat": 1792000000,
  "exp": 1792003600
}
```

## MFA

- **Onde** — TOTP (compatível com Google Authenticator, Authy e afins): o painel tem a área de MFA em **Segurança**, com QR code para registar o código e 10 códigos de recuperação guardados com bcrypt (cada um serve uma vez).
- **No login** — se a conta tem MFA activo, `POST /api/auth/login` devolve `requiresMfa: true` com um `mfa_temp`; `POST /api/auth/mfa-verify` aceita o TOTP ou um código de recuperação e só então emite a sessão definitiva (acção `login_mfa` fica nos registos de auditoria).
- **Opcional por premissão** — a definição `mfa_required` («Require MFA for all users») vem `false`; quando activada, o MFA deixa de ser opcional para os utilizadores do painel.
- **Em desenvolvimento** — hoje só TOTP e códigos de recuperação; verificação por SMS, e-mail e chaves físicas (FIDO2) estão planeadas, não implementadas nesta versão.

## Funções e permissões

Quatro funções de sistema, com permissões atribuídas no seed (`SEED_ROLE_PERMISSIONS`):

| Função | Alcance |
|--------|---------|
| `admin` | Todas as permissões do catálogo (acesso total) |
| `supervisor` | Principais permissões: `devices.manage`, `devices.commands`, `users.view`, `logs.view` — gestão de dispositivos e utilizadores, alertas e redes |
| `technician` | Principais permissões: `devices.view`, `devices.commands` — ver dispositivos e executar comandos |
| `user` | Apenas visualização (leitura) — é a função que o registo gratuito recebe |

- O enforcement é no servidor: cada rota usa `requirePermission(...)` e sem a permissão devolve `403` com `AUTH_PERMISSION_DENIED` — mesmo que o JWT diga o contrário. O cache de permissões (60 segundos) serve exactamente para isso: o RBAC relê as permissões actuais da BD mesmo com um JWT antigo, por isso uma alteração de permissões passa a valer em até 60 segundos — ou de imediato quando o cache é invalidado — sem esperar pela renovação da sessão.
- Novos registos entram como `user` (early access gratuito); administradores convidam com `POST /api/auth/invite`, que exige `users.manage` e escolhe a função do convidado.

```json
{
  "success": false,
  "error": {
    "message": "You do not have the required permissions to perform this action.",
    "code": "AUTH_PERMISSION_DENIED"
  }
}
```

## Registos de auditoria

- `audit_logs` é **append-only**: as rotas do painel só leem, nunca escrevem nem apagam — escrita apenas pela própria API em operações sensíveis.
- Leitura com permissão `logs.view`: `GET /api/audit` (paginação por `page`/`limit`), `GET /api/audit/stats` e `GET /api/audit/:id`; exportação com `logs.export` em `GET /api/audit/export`, ficheiro CSV com as 1000 linhas mais recentes (colunas ID, User, Action, Target, Description, IP, Date).
- Acções registadas incluem `login`, `logout`, `login_mfa`, `command_execute`, `scan_stopped`, `emergency_stop_enabled`, aprovações de dispositivos e decisões de instalação — sempre com utilizador e IP de origem.

```bash
curl -H "Authorization: Bearer <ACCESS_TOKEN>" https://endpointx-api-5ypc.onrender.com/api/audit/export -o audit-logs.csv
```

## Protecção de downloads

> **Nota:** a protecção dos binários públicos (instalador Windows e APK) — token de enrolamento válido ou sessão autorizada — é comportamento da plataforma na versão 1.3.0, aterando no mesmo release.

O que já está assim hoje:

- Os scripts de instalação (`install.ps1`, `install-linux.sh`, `install-macos.sh`) exigem token de enrolamento em `?t=`; sem ele a API responde `403` «Valid enrolment token required».
- Os downloads internos do painel exigem sessão autenticada: `GET /api/devices/download/installer` precisa de `devices.manage` e `GET /api/devices/download/agent/:filename` de sessão válida.
- O token de enrolamento só é emitido a sessões com `devices.manage` (`GET /api/devices/enroll-token`) e os scripts nunca guardam credenciais de administrador — apenas o token de enrolamento na configuração do agente.

## O que o EndpointX não recolhe

O agente **não** recolhe palavras-passe, keystrokes nem conteúdo de ficheiros — só o que é preciso para gerir e proteger o equipamento: inventário de hardware e software, processos e serviços, métricas de CPU, memória, disco e rede, e o estado de ligação do dispositivo.

- Os dados dos equipamentos ficam na base de dados da própria instalação (PostgreSQL): o agente só fala com a API do EndpointX e os registos ficam onde os corre. À parte, os módulos OSINT consultam fontes públicas externas (ex.: WHOIS, Shodan) apenas quando alguém executa uma consulta — e o SSO opcional liga-se a Microsoft/Google só se for activado.
- O alcance de cada módulo é declarado na API: `GET /api/netsentinel/privacy` devolve o que a camada Zero Trust lê e escreve.
- Módulos ainda em desenvolvimento (NAC, deploy de software, feed de CVE) aparecem como em desenvolvimento nesta versão 1.3.0, como o resto do produto.
