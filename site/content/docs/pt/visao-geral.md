---
title: Visão geral da plataforma
lead: Arquitectura, conceitos e o que cada área do painel faz.
description: Conheça a arquitectura do EndpointX em quatro camadas, os conceitos-chave — dispositivos, agentes, enrolamento e heartbeat — e o que cada área do painel faz.
---

## O que é o EndpointX

EndpointX é uma plataforma de gestão de identidade, acesso e endpoints (IAM + EPM) para gerir dispositivos autorizados numa rede corporativa. Combina monitorização em tempo real, execução remota de comandos e registo de eventos de segurança, tudo a partir de um painel administrativo único.

A plataforma é defensiva por desenho: só trabalha com dispositivos registados e autorizados, com intervalos de rede configurados pelo administrador, e não recolhe palavras-passe, keystrokes nem conteúdo de ficheiros.

## Arquitectura em 4 camadas

O sistema organiza-se em quatro camadas:

1. **Agentes** — correm nos endpoints autorizados (Windows, Linux e macOS), recolhem inventário e métricas e enviam heartbeats periódicos à API por HTTPS, com assinatura HMAC-SHA256.
2. **API Express** — backend em Node.js com Express e Socket.IO, autenticação JWT com refresh tokens, RBAC com permissões granulares, validação de entradas e registo de auditoria imutável.
3. **PostgreSQL** — base de dados principal (PostgreSQL 16) com chaves UUID, índices e logs de auditoria imutáveis; o Redis é usado como cache e para dados partilhados em tempo real.
4. **Dashboard React** — painel administrativo em React com actualizações em tempo real via WebSocket, interface sensível a permissões (RBAC-aware) e modo escuro.

> **Nota:** o intervalo de heartbeat é configurável (por omissão, 60 segundos) e o agente retenta automaticamente falhas de comunicação.

## Conceitos-chave

- **Utilizador e sessão** — os administradores autenticam-se com email e palavra-passe; a sessão usa um token de acesso de curta duração e um refresh token revogável, com MFA opcional.
- **Dispositivo e agente** — cada endpoint autorizado tem um registo no painel e um agente instalado que recolhe inventário (software, serviços, processos, partições, interfaces) e métricas de saúde.
- **Enrolamento** — os PCs juntam-se com um token de enrolamento e os telemóveis através de uma página PWA; cada dispositivo entra como pendente (PENDING) até ser aprovado por um administrador (Zero Trust).
- **Heartbeat** — o agente envia `POST /api/devices/heartbeat` com métricas (CPU, RAM, disco); a API responde com os comandos pendentes para o dispositivo.

Exemplo do ciclo de heartbeat:

```http
POST /api/devices/heartbeat
Content-Type: application/json

{
  "agent_id": "agt_…",
  "metrics": { "cpu": 42, "ram": 61, "disk": 73 }
}
```

## Áreas do painel

- **Dashboard** — visão geral com estado dos dispositivos, actividade recente e alertas.
- **Dispositivos** — inventário e saúde de cada endpoint, comandos remotos e histórico.
- **Rede / Descoberta** — varreduras de intervalos CIDR autorizados, revisão de nós descobertos (aprovar, ignorar ou pedir instalação) e decisões de acesso de rede (NAC), em desenvolvimento.
- **HERMES** — motor de inteligência defensiva que correlaciona inventário, portas, serviços e CVEs, apresentando risco com evidência, confiança e timestamp.
- **Segurança** — alertas, regras, incidentes, MFA e registos de auditoria.
- **Definições** — configuração da instalação, utilizadores, funções e permissões.

## Estado do desenvolvimento

O EndpointX está em early access gratuito na versão 1.3.0, em desenvolvimento contínuo. Estão disponíveis o registo de dispositivos, a monitorização com heartbeats, a análise de vulnerabilidades, o security monitoring e o controlo de acesso com auditoria.

Estão em construção as decisões de acesso de rede (NetSentinel / NAC) e outras capacidades assinaladas como «em desenvolvimento» no painel — preferimos diz-lo a fingir que estão prontas. Esta documentação descreve o sistema real, sem números de clientes nem certificações inventados.
