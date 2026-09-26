# Guia de Instalação - EndpointX Agent

## Guia Completo para Instalar o Agent em Novos PCs

---

## Pré-Requisitos

### No PC Servidor (já configurado)
- Backend a correr em `http://IP-DO-SERVIDOR:3001`
- Dashboard a correr em `http://localhost:5173`

### Nos PCs Remotos (a instalar)
- Python 3.10+ instalado
- Git instalado (opcional, mas recomendado)
- Acesso à rede ao servidor
- Firewall não bloqueia a porta 3001

---

## Método 1: Instalar via Git (Recomendado)

### Passo 1: Instalar Git

1. Abre o browser no PC remoto
2. Vai a: **https://git-scm.com/download/win**
3. Descarrega o **Git for Windows**
4. Instala com as opções padrão (pode deixar tudo default)

### Passo 2: Instalar Python

1. Vai a: **https://www.python.org/downloads/**
2. Clica em **"Download Python 3.x.x"**
3. Ao instalar, **marca esta caixa** (MUITO IMPORTANTE):
   ```
   ☑ Add Python to PATH
   ```
4. Clica em **"Install Now"**
5. Fecha e volta a abrir o PowerShell

### Passo 3: Clonar o Repositório

No PowerShell do PC remoto:

```cmd
cd C:\
git clone https://github.com/Masukulmiguel/endpointx.git
```

### Passo 4: Instalar Dependências

```cmd
cd C:\endpointx\endpoint-agent
pip install -r requirements.txt
```

### Passo 5: Registar e Correr

```cmd
python agent.py --register
python agent.py
```

### Para Atualizar o Agent

```cmd
cd C:\endpointx\endpoint-agent
git pull
python agent.py --register
python agent.py
```

---

## Método 2: Instalar via Cópia (Sem Git)

### Passo 1: Instalar Python no PC Remoto

1. Abre o browser no PC remoto
2. Vai a: **https://www.python.org/downloads/**
3. Clica em **"Download Python 3.x.x"**
4. Ao instalar, **marca esta caixa** (MUITO IMPORTANTE):
   ```
   ☑ Add Python to PATH
   ```
5. Clica em **"Install Now"**
6. Fecha e volta a abrir o PowerShell

---

### Passo 2: Copiar o Agent

Copia a pasta `endpoint-agent` para o PC remoto:

```
C:\endpoint-agent\
```

### Conteúdo da pasta:
```
C:\endpoint-agent\
├── agent.py          ← Script principal
├── config.yaml       ← Configuração
├── system_info.py    ← Coleta de informações
├── crypto_utils.py   ← Utilitários de segurança
├── requirements.txt  ← Dependências Python
└── README.md         ← Documentação
```

### Como copiar:
- **Pendrive**: Copia a pasta inteira e cola no PC remoto
- **Rede**: Partilha a pasta e acede pelo PC remoto
- **Download**: Descarrega do GitHub e extrai

---

### Passo 3: Instalar Dependências

No PowerShell do PC remoto:

```cmd
cd C:\endpoint-agent
pip install psutil requests pyyaml
```

### Se der erro "pip not recognized":
1. Fecha o PowerShell
2. Abre novo PowerShell como Administrador
3. Corre novamente o comando

---

### Passo 4: Configurar o Agent

Edita o ficheiro `config.yaml`:

```yaml
agent_id: AUTO
agent_secret: dev_agent_secret_123
heartbeat_interval: 60
server_url: http://192.168.2.39:3001/api
```

### Configurações:
| Campo | Valor | Descrição |
|-------|-------|-----------|
| `agent_id` | `AUTO` | Auto-detecta o hostname do PC |
| `agent_secret` | `dev_agent_secret_123` | Chave secreta partilhada |
| `heartbeat_interval` | `60` | Intervalo em segundos |
| `server_url` | `http://IP-DO-SERVIDOR:3001/api` | IP do servidor desta rede |

> **IMPORTANTE**: O `server_url` deve apontar para o IP do servidor nesta rede. Cada empresa tem o seu próprio servidor.

---

### Passo 5: Registar o Agent

```cmd
cd C:\endpoint-agent
python agent.py --register
```

### Saída esperada:
```
2026-09-19 11:19:35,155 [INFO] endpointx-agent: Registering device with server...
2026-09-19 11:19:35,253 [INFO] endpointx-agent: Device registered successfully. ID: xxxxxxxx
```

### Se der erro:
- Verifica se o servidor está a correr em `192.168.2.39:3001`
- Verifica se o firewall não bloqueia a porta 3001
- Verifica se o `agent_secret` está correto

---

### Passo 6: Correr o Agent

```cmd
cd C:\endpoint-agent
python agent.py
```

### Saída esperada:
```
2026-09-19 11:19:49,870 [INFO] endpointx-agent: EndpointX agent starting...
2026-09-19 11:19:49,871 [INFO] endpointx-agent: Server: http://192.168.2.39:3001/api
2026-09-19 11:19:49,871 [INFO] endpointx-agent: Heartbeat interval: 60s
2026-09-19 11:19:49,872 [INFO] endpointx-agent: Entering heartbeat loop...
2026-09-19 11:19:51,229 [INFO] endpointx-agent: Sending inventory to server...
2026-09-19 11:20:51,934 [INFO] endpointx-agent: Inventory sent successfully
```

---

### Passo 7: Verificar no Dashboard

1. Abre o browser no PC servidor
2. Vai a: **http://localhost:5173**
3. Login: `admin@endpointx.local` / a senha definida em `SEED_ADMIN_PASSWORD`
4. Vai a: **Devices**
5. O novo PC deve aparecer na lista

---

## Correr em Background (Opcional)

Para o agent correr em background (fechar PowerShell sem parar):

```cmd
cd C:\endpoint-agent
pythonw agent.py
```

Ou cria um ficheiro `iniciar.bat`:
```bat
@echo off
cd C:\endpoint-agent
python agent.py
```

---

## Instalação Linux e macOS (linha única)

Os scripts públicos fazem download do agent, criam o `config.yaml` com o servidor/token
automaticamente e registam o serviço (systemd no Linux, launchd no macOS):

### Linux (Debian/Ubuntu/Fedora — requer sudo)

```bash
curl -fsSL https://endpointx.onrender.com/api/devices/public/install-linux.sh | sudo bash
```

### macOS (utilizador normal)

```bash
curl -fsSL https://endpointx.onrender.com/api/devices/public/install-macos.sh | bash
```

### Gestão do serviço

```bash
# Linux
systemctl status endpointx-agent
journalctl -u endpointx-agent -f

# macOS
tail -f ~/endpointx-agent/agent-stdout.log
```

Pré-requisito: Python 3.8+. Os comandos também estão no dashboard em **Instalar Agente**.

---

## Script de Instalação Automática

Cria um ficheiro `instalar.bat` no PC remoto:

```bat
@echo off
echo ========================================
echo Instalando EndpointX Agent...
echo ========================================

REM Verificar se Python esta instalado
python --version >nul 2>&1
if errorlevel 1 (
    echo ERRO: Python nao encontrado!
    echo Por favor, instale Python de: https://www.python.org/downloads/
    echo Marque: Add Python to PATH
    pause
    exit /b 1
)

REM Instalar dependencias
echo Instalando dependencias...
pip install psutil requests pyyaml

REM Registar agent
echo Registando device no servidor...
python agent.py --register

REM Correr agent
echo Iniciando agent...
python agent.py

pause
```

---

## Troubleshooting

### Erro: "pip not recognized"
- Fecha e abre novo PowerShell
- Ou reinicia o PC

### Erro: "Connection failed"
- Verifica se o servidor está a correr
- Verifica o IP no `config.yaml` → `server_url`
- Verifica o firewall

### Erro: "Device already registered"
- O PC já está registado
- O agent vai funcionar normalmente

### Agent não aparece no dashboard
- Verifica se o agent está a correr
- Verifica os logs: `endpointx-agent.log`
- Espera 60 segundos (intervalo do heartbeat)

### Apagar registo e voltar a registar
```cmd
cd C:\endpoint-agent
del config.yaml
python agent.py --register
python agent.py
```

---

## Comandos Disponíveis

No dashboard, podes enviar estes comandos para cada PC:

| Comando | Descrição |
|---------|-----------|
| **Reboot** | Reinicia o PC |
| **Shutdown** | Desliga o PC |
| **Lock** | Bloqueia o ecrã |
| **Inventory** | Atualiza inventário de software |
| **Scan** | Verificação de segurança |
| **Get Info** | Informações detalhadas do sistema |

---

## Lista de PCs

| PC | Hostname | IP | Estado |
|----|----------|-----|--------|
| Servidor | DESKTOP-OSGM0IK | 192.168.2.39 | ✅ Online |
| PC Remoto 1 | FMLIDER-10 | 192.168.2.x | ✅ Online |
| PC Remoto 2 | ??? | 192.168.2.x | ⏳ Pendente |

---

## Resumo Rápido

```cmd
REM 1. Instalar Python (com Add to PATH)
REM 2. Copiar pasta endpoint-agent para C:\endpoint-agent
REM 3. Instalar dependências
pip install psutil requests pyyaml
REM 4. Registar
python agent.py --register
REM 5. Correr
python agent.py
```

---

## Para Empresas/Clientes (Deploy Externo)

Se vais vender ou deployar o sistema noutra empresa:

### 1. Instalar o Servidor na Empresa Cliente

No servidor da empresa cliente:
```bash
git clone https://github.com/Masukulmiguel/endpointx.git
cd endpointx/backend-api
npm install
npm run dev
```

O servidor vai correr no IP desta rede (ex: `10.0.0.100:3001`)

### 2. Configurar os Agents

Em cada PC da empresa cliente, altera o `config.yaml`:

```yaml
agent_id: AUTO
agent_secret: dev_agent_secret_123
heartbeat_interval: 60
server_url: http://IP-DO-SERVIDOR-DESTA-REDE:3001/api
```

### 3. Exemplo por Empresa

| Empresa | Servidor | Agents |
|---------|----------|--------|
| Empresa A | `http://10.0.0.100:3001/api` | Todos apontam para 10.0.0.100 |
| Empresa B | `http://192.168.1.50:3001/api` | Todos apontam para 192.168.1.50 |
| Empresa C | `http://172.16.0.10:3001/api` | Todos apontam para 172.16.0.10 |

### Cada empresa é independente:
- ✅ Servidor próprio
- ✅ Dashboard próprio
- ✅ Base de dados própria
- ✅ Agents próprios
- ✅ Não partilham dados entre si

---

*Guia atualizado em: 2026-09-19*
