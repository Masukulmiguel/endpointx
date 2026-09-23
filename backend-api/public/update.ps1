# EndpointX Agent Quick Update v1.1.0
# Safe for: irm https://.../update.ps1 | iex

$agentDir = "C:\endpointx\endpoint-agent"
$github = "https://raw.githubusercontent.com/Masukulmiguel/endpointx/main/endpoint-agent"
$ErrorActionPreference = "Continue"

function Write-Err($msg) { Write-Host $msg -ForegroundColor Red }
function Write-Ok($msg) { Write-Host $msg -ForegroundColor Cyan }

Write-Host ""
Write-Ok "  EndpointX - Atualizacao Rapida v1.1.0"
Write-Host ""

if (-not (Test-Path (Join-Path $agentDir "agent.py"))) {
    Write-Err "ERRO: Agent nao instalado em $agentDir"
    Write-Host "Execute o instalador completo primeiro." -ForegroundColor Yellow
    return
}

try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

Write-Host "[1/3] Parando agent EndpointX..." -ForegroundColor Green
try {
    $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Name -match '^python' -and $_.CommandLine -and
            ($_.CommandLine -like "*endpoint-agent*" -or $_.CommandLine -like "*agent.py*")
        }
    foreach ($p in $procs) {
        try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch { }
    }
} catch {
    Stop-Process -Name pythonw -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 1

Write-Host "[2/3] Baixando atualizacoes..." -ForegroundColor Green
try {
    Invoke-WebRequest -Uri "$github/agent.py" -OutFile "$agentDir\agent.py" -UseBasicParsing -TimeoutSec 60
    Invoke-WebRequest -Uri "$github/system_info.py" -OutFile "$agentDir\system_info.py" -UseBasicParsing -TimeoutSec 60
} catch {
    Write-Err "Falha no download: $($_.Exception.Message)"
    return
}

Write-Host "[3/3] Reiniciando agent..." -ForegroundColor Green
if (Test-Path "$agentDir\start_agent.vbs") {
    Start-Process -FilePath "wscript.exe" -ArgumentList "`"$agentDir\start_agent.vbs`""
} else {
    Start-Process -FilePath "pythonw" -ArgumentList "agent.py" -WorkingDirectory $agentDir -WindowStyle Hidden
}

Write-Ok "  Atualizacao concluida!"
Write-Host ""
