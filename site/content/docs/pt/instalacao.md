---
title: Instalação e requisitos
lead: Pré-requisitos, primeiros passos e instalação do agente.
description: Requisitos, conta, token de enrolamento e comandos exactos para instalar o agente EndpointX em Windows, Linux, macOS e telemóveis.
---

## Requisitos

Para instalar o agente num endpoint autorizado precisa de:

- **Conta no EndpointX** — o early access gratuito da versão 1.3.0 arranca com uma conta de administrador criada no primeiro boot (a partir de `SEED_ADMIN_PASSWORD`, mínimo 12 caracteres) e permite registo livre de novos utilizadores.
- **Python no endpoint** — no Windows, Python instalado com «Add Python to PATH» marcado; em Linux e macOS, Python 3.8+. O guia de instalação recomenda Python 3.10+ nos PCs remotos.
- **Rede** — o endpoint tem de alcançar a API por HTTPS. Em instalações locais, o firewall não pode bloquear a porta do backend (3001 por omissão).
- **Permissão de gestão** — os comandos de instalação e os tokens de enrolamento são emitidos por contas com a permissão `devices.manage` (funções administradoras).

Os scripts configuram o agente automaticamente para apontar à API — não é preciso editar `config.yaml` manualmente.

## Criar conta e obter o token

Crie a conta (registo gratuito de early access), entre no painel e abra a página **Instalar Agente**. O painel busca o token de enrolamento da conta com `GET /api/devices/enroll-token` e apresenta o comando já completo, com o token incluído.

O token também pode ser obtido à mão com uma sessão admin:

```bash
curl -H "Authorization: Bearer <ADMIN_JWT>" https://endpointx.onrender.com/api/devices/enroll-token
```

O token dura 30 dias (`expires_in: "30d"`), pertence à conta que o emitiu e é uma credencial — nunca o comite nem o partilhe fora do painel. Sem um token válido, os scripts de instalação recusam-se a correr (HTTP 403 «Valid enrolment token required»).

## Windows (PowerShell)

No PC remoto, abra o PowerShell e cole (não feche a shell):

```powershell
irm https://endpointx-api-5ypc.onrender.com/api/devices/public/install.ps1?t=<ENROLL_TOKEN> | iex
```

O comando é exactamente o que a página **Instalar Agente** mostra, já com o `?t=` da sua conta. O script:

1. verifica que o Python está no PATH (falha com instruções se não estiver);
2. cria `C:\endpointx\endpoint-agent` e descarrega os ficheiros do agente;
3. escreve o `config.yaml` com o servidor, o segredo da frota e o seu token;
4. instala as dependências (`psutil`, `requests`, `pyyaml`) e regista o dispositivo (`python agent.py --register`);
5. cria um lançador em background e copia-o para a pasta de Arranque, para o agente arrancar em cada sessão de login.

## Linux e macOS

No terminal do dispositivo (configuração e registo automáticos):

```bash
# Linux (Debian/Ubuntu/Fedora — requer sudo)
curl -fsSL https://endpointx-api-5ypc.onrender.com/api/devices/public/install-linux.sh?t=<ENROLL_TOKEN> | sudo bash

# macOS (utilizador normal)
curl -fsSL https://endpointx-api-5ypc.onrender.com/api/devices/public/install-macos.sh?t=<ENROLL_TOKEN> | bash
```

O agent corre como serviço — systemd no Linux, launchd no macOS — e arranca automaticamente. Para acompanhar:

```bash
# Linux
systemctl status endpointx-agent
journalctl -u endpointx-agent -f

# macOS
tail -f ~/endpointx-agent/agent-stdout.log
```

## Telemóvel (Android/iOS)

No telemóvel, abra o link de registo (página mobile, com o token da conta):

```
https://endpointx-api-5ypc.onrender.com/api/devices/public/mobile?t=<ENROLL_TOKEN>
```

A página também está acessível por QR code na página **Instalar Agente**, em `GET /api/devices/public/mobile`, e o registo passa por `POST /api/devices/mobile/register`. Para gestão por MDM: Android Enterprise, Apple Business Manager, Intune e Jamf.

Para **ver e controlar o ecrã** do telemóvel a partir do painel (remoto assistido), instale a app Android (Android 8.0+, v1.3.0, assinada, ~1 MB, com permissões de acessibilidade e partilha de ecrã):

```
https://endpointx-api-5ypc.onrender.com/api/devices/public/endpointx-agent.apk
```

Com o telemóvel ligado por USB e depuração USB activa, a instalação assistida activa o controlo sem tocar nas definições do Android:

```bash
adb shell pm grant pt.endpointx.agent android.permission.WRITE_SECURE_SETTINGS
adb shell settings put secure enabled_accessibility_services pt.endpointx.agent/.ControlService
adb shell settings put secure accessibility_enabled 1
```

Há também o script `https://endpointx-api-5ypc.onrender.com/api/devices/public/enable-control.bat`, que instala o APK e liga o serviço de acessibilidade. Nota (Android 13+): o controlo remoto é bloqueado em apps instaladas por APK até se activar «Permitir definições restritas» em Definições → Apps → EndpointX.

## Verificar que o dispositivo entrou

1. Aguarde até um ciclo de heartbeat (60 segundos por omissão) — o agente regista-se e começa a reportar de imediato.
2. No painel, abra **Dispositivos**: o endpoint deve aparecer com estado `online`, métricas e inventário.
3. Telemóveis entram como `PENDING` (Zero Trust) até um administrador os aprovar em **Dispositivos** — aprovados, passam a `approved`/`is_authorized`.
4. Em caso de dúvida, confirme o log local `endpointx-agent.log` na pasta do agente e consulte a lista com `GET /api/devices` (requer `devices.view`).

## Actualizações

Actualização rápida do agente já instalado, em Windows:

```powershell
irm https://endpointx-api-5ypc.onrender.com/api/devices/public/update.ps1 | iex
```

O script para o agente, descarrega os ficheiros actualizados e volta a arrancá-lo em background. Também pode mandar a actualização pelo painel: o comando `update_agent` (criado com `POST /api/devices/:id/update-agent`, requer `devices.commands`) é entregue ao agente no próximo heartbeat. Em Linux e macOS, correr de novo o script de instalação da secção anterior repõe os ficheiros mais recentes.
