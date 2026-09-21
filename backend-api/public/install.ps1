$ErrorActionPreference = "Stop"

$serverUrl = "##SERVER_URL##"

Write-Host ""
Write-Host "  ███████╗███████╗███╗   ██╗████████╗██╗███╗   ██╗███████╗" -ForegroundColor Cyan
Write-Host "  ██╔════╝██╔════╝████╗  ██║╚══██╔══╝██║████╗  ██║██╔════╝" -ForegroundColor Cyan
Write-Host "  █████╗  █████╗  ██╔██╗ ██║   ██║   ██║██╔██╗ ██║███████╗" -ForegroundColor Cyan
Write-Host "  ██╔══╝  ██╔══╝  ██║╚██╗██║   ██║   ██║██║╚██╗██║╚════██║" -ForegroundColor Cyan
Write-Host "  ██║     ███████╗██║ ╚████║   ██║   ██║██║ ╚████║███████║" -ForegroundColor Cyan
Write-Host "  ╚═╝     ╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚═╝╚═╝  ╚═══╝╚══════╝" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Endpoint Management System v1.0.0" -ForegroundColor Gray
Write-Host "  by Masukulu Miguel" -ForegroundColor DarkGray
Write-Host "  Server: $serverUrl" -ForegroundColor Gray
Write-Host ""

try {
    $python = Get-Command python -ErrorAction Stop
} catch {
    Write-Host "ERRO: Python nao encontrado!" -ForegroundColor Red
    Write-Host "Instale de: https://www.python.org/downloads/" -ForegroundColor Yellow
    Write-Host "Marque: Add Python to PATH" -ForegroundColor Yellow
    Read-Host "Press Enter para sair"
    exit 1
}

Write-Host "[1/5] Criando pasta..." -ForegroundColor Green
New-Item -ItemType Directory -Force -Path "C:\endpointx\endpoint-agent" | Out-Null

Write-Host "[2/5] Baixando agent do GitHub..." -ForegroundColor Green
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$github = "https://raw.githubusercontent.com/Masukulmiguel/endpointx/main/endpoint-agent"
Invoke-WebRequest -Uri "$github/agent.py" -OutFile "C:\endpointx\endpoint-agent\agent.py" -UseBasicParsing
Invoke-WebRequest -Uri "$github/system_info.py" -OutFile "C:\endpointx\endpoint-agent\system_info.py" -UseBasicParsing
Invoke-WebRequest -Uri "$github/requirements.txt" -OutFile "C:\endpointx\endpoint-agent\requirements.txt" -UseBasicParsing

Write-Host "[3/5] Criando config..." -ForegroundColor Green
@"
agent_id: AUTO
agent_secret: dev_agent_secret_123
heartbeat_interval: 60
log_file: endpointx-agent.log
log_level: INFO
server_url: ${serverUrl}/api
"@ | Out-File -FilePath "C:\endpointx\endpoint-agent\config.yaml" -Encoding utf8

Write-Host "[4/5] Instalando dependencias..." -ForegroundColor Green
pip install psutil requests pyyaml 2>$null | Out-Null

Write-Host "[5/5] Registrando device..." -ForegroundColor Green
Set-Location "C:\endpointx\endpoint-agent"
python agent.py --register

@"
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\endpointx\endpoint-agent"
WshShell.Run "pythonw.exe agent.py", 0, False
"@ | Set-Content -Path "C:\endpointx\endpoint-agent\start_agent.vbs" -Encoding ASCII -Force

Copy-Item "C:\endpointx\endpoint-agent\start_agent.vbs" "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\endpointx.vbs" -Force

Write-Host ""
Write-Host "Iniciando agent..." -ForegroundColor Green
Start-Process -FilePath "wscript.exe" -ArgumentList "C:\endpointx\endpoint-agent\start_agent.vbs"

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Instalacao concluida!" -ForegroundColor Green
Write-Host "  Agent rodando em background." -ForegroundColor Green
Write-Host "  Inicia automaticamente no login." -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Read-Host "Press Enter para fechar"
