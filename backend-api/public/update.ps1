$ErrorActionPreference = "Stop"

$agentDir = "C:\endpointx\endpoint-agent"
$github = "https://raw.githubusercontent.com/Masukulmiguel/endpointx/main/endpoint-agent"

Write-Host ""
Write-Host "  EndpointX - Atualizacao Rapida" -ForegroundColor Cyan
Write-Host ""

if (-not (Test-Path "$agentDir\agent.py")) {
    Write-Host "ERRO: Agent nao instalado!" -ForegroundColor Red
    Write-Host "Execute o instalador completo primeiro." -ForegroundColor Yellow
    Read-Host "Press Enter para sair"
    exit 1
}

Write-Host "[1/3] Parando agent..." -ForegroundColor Green
Stop-Process -Name pythonw -Force -ErrorAction SilentlyContinue
Stop-Process -Name python -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Write-Host "[2/3] Baixando atualizacoes..." -ForegroundColor Green
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -Uri "$github/agent.py" -OutFile "$agentDir\agent.py" -UseBasicParsing
Invoke-WebRequest -Uri "$github/system_info.py" -OutFile "$agentDir\system_info.py" -UseBasicParsing

Write-Host "[3/3] Reiniciando agent..." -ForegroundColor Green
Start-Process -FilePath "wscript.exe" -ArgumentList "$agentDir\start_agent.vbs"

Write-Host ""
Write-Host "  Atualizacao concluida!" -ForegroundColor Green
Write-Host "  Agent reiniciado com sucesso." -ForegroundColor Green
Write-Host ""
Read-Host "Press Enter para fechar"
