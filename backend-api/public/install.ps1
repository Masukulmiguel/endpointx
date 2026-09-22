$ErrorActionPreference = "Stop"

$serverUrl = "##SERVER_URL##"
$agentSecret = "##AGENT_SECRET##"
$agentDir = "C:\endpointx\endpoint-agent"
$github = "https://raw.githubusercontent.com/Masukulmiguel/endpointx/main/endpoint-agent"

Write-Host ""
Write-Host "  ╔═════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "  ║                                     ║" -ForegroundColor Cyan
Write-Host "  ║        EndpointX  v1.1.0            ║" -ForegroundColor Cyan
Write-Host "  ║   Endpoint Management System        ║" -ForegroundColor Cyan
Write-Host "  ║                                     ║" -ForegroundColor Cyan
Write-Host "  ║   by Masukulu Miguel                ║" -ForegroundColor DarkGray
Write-Host "  ║                                     ║" -ForegroundColor Cyan
Write-Host "  ╚═════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Server: $serverUrl" -ForegroundColor Gray
Write-Host ""

# Check Python
try {
    $python = Get-Command python -ErrorAction Stop
} catch {
    Write-Host "ERRO: Python nao encontrado!" -ForegroundColor Red
    Write-Host "Instale de: https://www.python.org/downloads/" -ForegroundColor Yellow
    Write-Host "Marque: Add Python to PATH" -ForegroundColor Yellow
    Read-Host "Press Enter para sair"
    exit 1
}

# Detect install vs update
$isUpdate = Test-Path "$agentDir\agent.py"

if ($isUpdate) {
    Write-Host "[INFO] Agent ja instalado. Atualizando..." -ForegroundColor Yellow
    Write-Host ""

    # Stop running agent
    Write-Host "[1/4] Parando agent..." -ForegroundColor Green
    Stop-Process -Name pythonw -Force -ErrorAction SilentlyContinue
    Stop-Process -Name python -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2

    # Download updated files
    Write-Host "[2/4] Baixando atualizacoes do GitHub..." -ForegroundColor Green
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri "$github/agent.py" -OutFile "$agentDir\agent.py" -UseBasicParsing
    Invoke-WebRequest -Uri "$github/system_info.py" -OutFile "$agentDir\system_info.py" -UseBasicParsing

    # Update config with new server URL if changed
    Write-Host "[3/4] Atualizando config..." -ForegroundColor Green
    $configContent = @"
agent_id: AUTO
agent_secret: ${agentSecret}
heartbeat_interval: 60
log_file: endpointx-agent.log
log_level: INFO
server_url: ${serverUrl}/api
"@
    $configContent | Out-File -FilePath "$agentDir\config.yaml" -Encoding utf8 -Force

    # Restart agent
    Write-Host "[4/4] Reiniciando agent..." -ForegroundColor Green
    Start-Process -FilePath "wscript.exe" -ArgumentList "$agentDir\start_agent.vbs"

    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Atualizacao concluida!" -ForegroundColor Green
    Write-Host "  Agent reiniciado com sucesso." -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
} else {
    Write-Host "[1/5] Criando pasta..." -ForegroundColor Green
    New-Item -ItemType Directory -Force -Path $agentDir | Out-Null

    Write-Host "[2/5] Baixando agent do GitHub..." -ForegroundColor Green
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri "$github/agent.py" -OutFile "$agentDir\agent.py" -UseBasicParsing
    Invoke-WebRequest -Uri "$github/system_info.py" -OutFile "$agentDir\system_info.py" -UseBasicParsing
    Invoke-WebRequest -Uri "$github/requirements.txt" -OutFile "$agentDir\requirements.txt" -UseBasicParsing

    Write-Host "[3/5] Criando config..." -ForegroundColor Green
    @"
agent_id: AUTO
agent_secret: ${agentSecret}
heartbeat_interval: 60
log_file: endpointx-agent.log
log_level: INFO
server_url: ${serverUrl}/api
"@ | Out-File -FilePath "$agentDir\config.yaml" -Encoding utf8

    Write-Host "[4/5] Instalando dependencias..." -ForegroundColor Green
    pip install psutil requests pyyaml 2>$null | Out-Null

    Write-Host "[5/5] Registrando device..." -ForegroundColor Green
    Set-Location $agentDir
    python agent.py --register

    # Create VBS launcher
    @"
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "$agentDir"
WshShell.Run "pythonw.exe agent.py", 0, False
"@ | Set-Content -Path "$agentDir\start_agent.vbs" -Encoding ASCII -Force

    # Auto-start on login
    Copy-Item "$agentDir\start_agent.vbs" "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\endpointx.vbs" -Force

    # Start agent
    Write-Host ""
    Write-Host "Iniciando agent..." -ForegroundColor Green
    Start-Process -FilePath "wscript.exe" -ArgumentList "$agentDir\start_agent.vbs"

    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Instalacao concluida!" -ForegroundColor Green
    Write-Host "  Agent rodando em background." -ForegroundColor Green
    Write-Host "  Inicia automaticamente no login." -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
}

Read-Host "Press Enter para fechar"
