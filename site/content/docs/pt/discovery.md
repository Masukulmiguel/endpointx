---
title: Network Discovery
lead: Intervalos CIDR, revisão de nós e pedidos de instalação.
description: Como executar uma descoberta de rede, validar os intervalos CIDR, rever os nós encontrados e transformá-los em pedidos de instalação com consentimento.
---

## O que é a Network Discovery

A Network Discovery usa um agente autorizado com estado `online` para mapear os equipamentos da sua rede: endereço MAC (com vendor OUI), IP, nome resolvido e sistema operativo estimado.

A descoberta **corre no endpoint, não no servidor**: o painel emite o comando `network_discovery` e o agente faz a varredura com a tabela de vizinhos (ARP/neighbours), um ping orçamentado e reverse DNS. Os resultados ficam em `network_nodes` — `review_status` inicial `new`, deduplicados por MAC (sem MAC, por IP) — e os hosts sem agente associado ficam como `node_type = UNKNOWN`, gerando uma recomendação HERMES «identify_device» para os identificar.

Áreas do painel: **Rede** (`/network`) para o mapa e **Dispositivos Descobertos** (`/network/discovery`) para as execuções e a fila de revisão. Listar nós: `GET /api/netsentinel/discovery/nodes` (requer `network.view`).

## Intervalos CIDR autorizados

Dois níveis de validação:

- **Servidor** — o campo `cidr` tem de ser uma rede privada RFC1918 com prefixo entre /8 e /30 (ex.: `192.168.1.0/24`, `10.0.0.0/24`); caso contrário devolve `Invalid cidr: use a private RFC1918 CIDR like 192.168.1.0/24`.
- **Agente** — só varre as sub-redes RFC1918 do próprio equipamento (no máximo 4 sub-redes; redes maiores que /22 são truncadas ao primeiro bloco de /22, nunca expandidas). Um `cidr` pedido tem de estar contido numa dessas sub-redes e não pode passar do tecto de /22 (1024 hosts).

Limites de segurança da varredura: orçamento de 60 segundos e no máximo 64 pings em simultâneo. Sem `cidr`, o agente varre as suas próprias sub-redes.

> **Nota:** deixe o campo vazio para descobrir apenas a sub-rede onde o agente está instalado; use um `cidr` explícito para alargar dentro do mesmo segmento.

## Correr uma descoberta

```http
POST /api/netsentinel/discovery/run
Authorization: Bearer <ACCESS_TOKEN>
Content-Type: application/json

{
  "device_id": "…",
  "cidr": "192.168.1.0/24"
}
```

Resposta `201`:

```json
{ "run_id": "…", "command_id": "…", "device_id": "…" }
```

- Requer a permissão `network.view` e um agente `online`; sem agente disponível devolve `No online agent available to run discovery`, e um dispositivo desligado `Device is offline or not an agent`.
- Cada agente só pode ter uma execução de cada vez (`409` se já houver uma em curso).
- O resultado aparece na fila de revisão; as execuções ficam visíveis em `GET /api/netsentinel/discovery`.

## Fila de revisão

Cada nó novo fica `new` até decidir. Por nó (`POST /api/netsentinel/discovery/nodes/:id/...`, `network.view`, excepto `enroll-request`):

- **`mark-known`** — o equipamento é da sua rede e já é conhecido.
- **`ignore`** — sai do fluxo de revisão (routers, impressoras, etc.).
- **`identify`** — regista um nome/nota para o nó.
- **`enroll-request`** — (requer `devices.manage`) abre um pedido de instalação, passando o nó a `enrollment_requested`.

`GET /api/netsentinel/discovery/nodes/:id` devolve o detalhe de cada nó, incluindo o histórico de execuções em que foi visto.

## Do nó ao pedido de instalação

1. **Criar** — `POST /api/netsentinel/discovery/install-requests` com `node_ids` (lote até 100) e `devices.manage`. Cada pedido guarda `invite_token`, `install_jti` e `os_hint`, com validade de **7 dias** (`REQUEST_TTL_DAYS`), e gera os comandos certos para o SO do nó (`buildInstallCommands`).
2. **Entregar** — o link de consentimento é `https://endpointx.onrender.com/api/enroll/invite/<TOKEN>` (`buildInviteUrl`); o pedido passa a `delivered` quando o destinatário abre o link.
3. **Decidir** — no link web (ou no diálogo nativo do instalador) o utilizador autoriza ou recusa: `authorized` avança para instalação (script com o token de instalação embutido), `refused` fecha o pedido e o nó volta a `new`.
4. **Completar** — `installing` → `installed` → `integrated`, à medida que o agente se regista e é aprovado; `GET /api/netsentinel/discovery/install-requests` lista os pedidos.
5. **Gestão** — `POST /api/netsentinel/discovery/install-requests/:id/cancel` cancela, `.../retry` gera um novo token e volta a abrir o pedido. Expirados ou cancelados, os pedidos não podem ser reutilizados e o nó volta a `new` — só existe um pedido activo por nó.

## NetSentinel/NAC (em desenvolvimento)

A camada Zero Trust do EndpointX (NetSentinel) está **em desenvolvimento** nesta versão 1.3.0, como o resto do produto. Enquanto isso já existem as bases: políticas NAC (`GET/POST /api/netsentinel/nac/policies`), avaliação (`POST /api/netsentinel/nac/evaluate`), decisões de confiança (`GET /api/netsentinel/nac/decisions`, `GET /api/netsentinel/devices/:id/trust`) e incidentes (`/api/netsentinel/incidents`), mas o motor de políticas e a aplicação automática de acesso estão em construção — trate-os como pré-visualização, não como comportamento final.
