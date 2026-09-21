# Deploy no Render (Grátis)

## Passo 1: Criar Conta no Render

1. Vai a: **https://render.com**
2. Clica em **"Get Started for Free"**
3. Cria conta com GitHub, Google ou email

## Passo 2: Criar Web Service

1. No Dashboard, clica em **"New +"** → **"Web Service"**
2. Conecta o teu GitHub: **https://github.com/Masukulmiguel/endpointx**
3. Configura:
   - **Name**: `endpointx-api`
   - **Runtime**: `Node`
   - **Branch**: `main`
   - **Build Command**: `cd backend-api && npm install && npm run build`
   - **Start Command**: `cd backend-api && npm start`
   - **Plan**: `Free`

## Passo 3: Variáveis de Ambiente

No painel do serviço, vai a **"Environment"** e adiciona:

| Key | Value |
|-----|-------|
| `NODE_ENV` | `production` |
| `PORT` | `3001` |
| `AGENT_SECRET` | `dev_agent_secret_123` |

## Passo 4: Deploy

1. Clica em **"Create Web Service"**
2. O Render vai fazer deploy automaticamente (2-3 minutos)
3. Quando terminar, vou ter um URL como:
   ```
   https://endpointx-api.onrender.com
   ```

## Passo 5: Testar

Vai a: `https://endpointx-api.onrender.com/health`

Deve retornar:
```json
{"status":"ok","timestamp":"...","uptime":...}
```

## Passo 6: Configurar os Agents

No `config.yaml` de cada PC remoto:
```yaml
agent_id: AUTO
agent_secret: dev_agent_secret_123
heartbeat_interval: 60
server_url: https://endpointx-api.onrender.com/api
```

## Passo 7: Dashboard (Opcional)

Para deployar o dashboard no Render:
1. Cria um novo **Static Site**
2. Connecta o mesmo repositório
3. **Build Command**: `cd admin-dashboard && npm install && npm run build`
4. **Publish Directory**: `admin-dashboard/dist`

## Notas Importantes

### Render Free Tier
- O serviço dorme após 15 minutos sem tráfego
- Demora ~30 segundos a acordar
- Para evitar isto, podes usar um serviço de "keep alive"

### Dados SQLite
- O Render free tier tem filesystem efémero
- Os dados podem ser perdidos entre reinícios
- Para produção, usa PostgreSQL (Render tem plano grátis para isso)

### URLs Finais
- **API**: `https://endpointx-api.onrender.com`
- **Dashboard**: `https://endpointx-dashboard.onrender.com` (se deployares)
- **Agent config**: `server_url: https://endpointx-api.onrender.com/api`
