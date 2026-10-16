---
title: Gestão de agentes
lead: Enrolamento, heartbeat, tokens e actualizações.
description: Como o agente EndpointX se enrola, o ciclo de heartbeat e os seus limiares, os tipos de token, os comandos remotos e a actualização ou desinstalação.
---

## O que é o agent

O agente é o programa que corre nos endpoints autorizados e alimenta o painel de dados reais. Em Windows, Linux e macOS é um agente Python (baseado em `psutil`) que:

- **recolhe inventário** — software, serviços, processos, partições e interfaces;
- **reporta métricas** — CPU, RAM, disco e tráfego de rede, com a capacidade total de cada componente;
- **mantém heartbeat** — envia `POST /api/devices/heartbeat` e `POST /api/devices/command-poll` à API por HTTPS, autenticando-se com o segredo partilhado da frota (`X-Agent-Secret`);
- **executa comandos** — recebe comandos do painel na resposta do heartbeat ou do poll e devolve o resultado.

Em Windows corre em background com arranque automático no login; em Linux corre como serviço systemd e em macOS como serviço launchd. Os telemóveis não correm o agente Python: a página mobile regista o dispositivo e mantém presença com `POST /api/devices/mobile/heartbeat` (com o seu próprio token), e a app Android acrescenta o controlo remoto.

Exemplo da configuração escrita pelo instalador:

```yaml
agent_id: AUTO
heartbeat_interval: 60
server_url: https://endpointx-api-5ypc.onrender.com/api
```

## Enrolamento e estado PENDING

- **PCs** — o instalador corre `python agent.py --register`, que chama `POST /api/devices/register` com o segredo da frota e o token de enrolamento da conta. O dispositivo fica ligado à conta (`created_by`) e autorizado para trabalhar.
- **Telemóveis** — `POST /api/devices/mobile/register` exige também token de enrolamento e cria o dispositivo com `approval_status = 'pending'` e `is_authorized = false`: entra como **PENDING** no painel.
- **Aprovação (Zero Trust)** — `POST /api/netsentinel/devices/:id/approve` passa o dispositivo a `approved`/`is_authorized` e o `trust_level` a `KNOWN`; `POST /api/netsentinel/devices/:id/reject` marca `rejected`, `trust_level = BLOCKED` e `is_authorized = false`. Só a conta que criou o dispositivo (ou um administrador) pode decidir.
- **Sem duplicados** — um re-registo da mesma máquina (mesmo IP, mesmo SO e nome/modelo correspondentes) reutiliza a linha existente em vez de criar um segundo registo; o mesmo vale para telemóveis com o APK reinstalado.

## Heartbeat e limiares

- **Intervalo** — configurável (`heartbeat_interval`, 60 segundos por omissão). Cada heartbeat actualiza estado, métricas e capacidade de hardware, e devolve os comandos pendentes do dispositivo.
- **Poll de comandos** — `POST /api/devices/command-poll` é feito pelo agente de 15 em 15 segundos (por omissão; configurável com `command_poll_interval` no `config.yaml`), para um comando do painel não ficar à espera do próximo heartbeat.
- **Offline** — um dispositivo sem heartbeat durante `OFFLINE_THRESHOLD` (300 segundos, 5 minutos, por omissão) passa a `offline`. Os telemóveis usam `MOBILE_OFFLINE_THRESHOLD` (1800 segundos, 30 minutos) porque os navegadores congelam os timers em segundo plano — ambos os valores estão definidos no deploy.
- **Alertas de offline** — as regras de limiar aceitam o desvio `offline` entre 30 e 86400 segundos.
- **Dispositivos contidos** — bloqueados ou em quarentena continuam a aceitar métricas, mas não voltam a `online` e só recebem comandos de contenção (`isolate`, `unisolate`, `quarantine`).

Exemplo do poll de comandos:

```http
POST /api/devices/command-poll
Content-Type: application/json
X-Agent-Secret: <AGENT_SECRET>

{
  "agent_id": "agt_…"
}
```

## Tokens (enrolamento vs sessão)

| Tipo | Para quê | Duração | Como se obtém |
|------|----------|---------|----------------|
| Enrolamento (`typ: enroll`) | Ligar dispositivos à conta nos scripts e links mobile | 30 dias | `GET /api/devices/enroll-token` (requer `devices.manage`), levado em `?t=` |
| Instalação (`typ: install`) | Pedidos de instalação originados na Network Discovery | 7 dias, ligado ao pedido (jti) | Devolvido com o pedido (`buildInstallCommands`); só liberta scripts se o pedido estiver autorizado |
| Sessão de administrador | Autenticar o painel e a API | Access de curta duração + refresh de 7 dias ligado a `sid` | Login (`POST /api/auth/login`); revogada no logout |
| Segredo do agente | `register`, `heartbeat`, `command-poll` | Enquanto configurado no deploy | `X-Agent-Secret`, gerado no servidor |

Os agentes **nunca** usam tokens de sessão de administrador — apenas o segredo da frota e, quando existir, o token de enrolamento/instalação embutido na configuração.

Resposta de emissão do token de enrolamento:

```json
{
  "success": true,
  "data": { "token": "eyJhbGciOi…", "expires_in": "30d" }
}
```

## Comandos remotos

Comandos aceites (`POST /api/commands`, requer `devices.commands`):

`reboot`, `shutdown`, `lock`, `unlock`, `inventory`, `update_agent`, `scan`, `get_info`, `uninstall_agent`, `isolate`, `unisolate`, `quarantine`, `network_discovery`.

```http
POST /api/commands
Authorization: Bearer <ACCESS_TOKEN>
Content-Type: application/json

{
  "device_id": "…",
  "command_type": "reboot"
}
```

- **Entrega** — os comandos `pending` são reclamados pelo heartbeat (até 10 de cada vez, 5 em contenção) ou pelo poll; `processing` sem confirmação durante 5 minutos passa a `failed`.
- **Cancelamento** — `POST /api/commands/:id/cancel` cancela comandos ainda `pending`.
- **Auditoria** — cada comando é registado em `audit_logs` com a acção `command_execute` e o IP de quem o emitiu.
- **Restrição** — `uninstall_agent` só pode ser emitido por administradores e o payload leva assinatura HMAC-SHA256 que o agente valida antes de correr.

## Actualizar ou desinstalar

**Actualizar (Windows):**

```powershell
irm https://endpointx-api-5ypc.onrender.com/api/devices/public/update.ps1 | iex
```

**Actualizar (painel):** o comando `update_agent`, criado com `POST /api/devices/:id/update-agent`, actualiza os ficheiros do agente no dispositivo seleccionado.

**Desinstalar:** envie o comando `uninstall_agent` pelo painel (função admin, com a assinatura HMAC descrita acima). Localmente, a pasta do agente inclui também o script `desinstalar.bat` para remoção manual. Depois de desinstalar, volta a instalar com os comandos da página de [Instalação](/docs/instalacao).
