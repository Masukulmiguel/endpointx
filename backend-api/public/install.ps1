# EndpointX Agent Installer v1.1.0
# Safe for: irm https://.../install.ps1 | iex
# Does NOT use exit/Read-Host/Set-Location (those break iex pipelines).

$serverUrl = "##SERVER_URL##"
$agentSecret = "##AGENT_SECRET##"
$agentDir = "C:\endpointx\endpoint-agent"
$github = "https://raw.githubusercontent.com/Masukulmiguel/endpointx/main/endpoint-agent"
$ErrorActionPreference = "Continue"

function Write-Step($msg) { Write-Host $msg -ForegroundColor Green }
function Write-Info($msg) { Write-Host $msg -ForegroundColor Yellow }
function Write-Err($msg) { Write-Host $msg -ForegroundColor Red }
function Write-Ok($msg) { Write-Host $msg -ForegroundColor Cyan }

Write-Host ""
Write-Ok "  EndpointX v1.1.0 - Agent Installer"
Write-Host "  Server: $serverUrl" -ForegroundColor Gray
Write-Host ""

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch { }

# Python check (no exit — just fail soft for iex)
$pythonCmd = $null
foreach ($name in @('python', 'python3', 'py')) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { $pythonCmd = $cmd.Source; break }
}
if (-not $pythonCmd) {
    Write-Err "ERRO: Python nao encontrado."
    Write-Info "Instale: https://www.python.org/downloads/ e marque 'Add Python to PATH'."
    Write-Info "Depois execute novamente o comando de instalacao."
    return
}

$isUpdate = Test-Path (Join-Path $agentDir "agent.py")

function Stop-AgentProcesses {
    # Only stop processes whose command line references endpoint-agent (do not kill all Python)
    try {
        $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object {
                $_.Name -match '^python' -and
                $_.CommandLine -and
                ($_.CommandLine -like "*endpoint-agent*" -or $_.CommandLine -like "*agent.py*")
            }
        foreach ($p in $procs) {
            try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch { }
        }
    } catch {
        Stop-Process -Name pythonw -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 1
}

function Get-File($url, $out) {
    Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing -TimeoutSec 60
}

try {
    if (-not (Test-Path $agentDir)) {
        New-Item -ItemType Directory -Force -Path $agentDir | Out-Null
    }

    if ($isUpdate) {
        Write-Step "[1/4] Parando agent EndpointX..."
        Stop-AgentProcesses

        Write-Step "[2/4] Baixando atualizacoes..."
        Get-File "$github/agent.py" (Join-Path $agentDir "agent.py")
        Get-File "$github/system_info.py" (Join-Path $agentDir "system_info.py")
        if (Test-Path "$github/requirements.txt") {
            Get-File "$github/requirements.txt" (Join-Path $agentDir "requirements.txt")
        }

        Write-Step "[3/4] Atualizando config.yaml..."
        $config = @"
agent_id: AUTO
agent_secret: $agentSecret
heartbeat_interval: 60
log_file: endpointx-agent.log
log_level: INFO
server_url: $serverUrl/api
"@
        Set-Content -Path (Join-Path $agentDir "config.yaml") -Value $config -Encoding utf8 -Force

        Write-Step "[4/4] Reiniciando agent..."
        $vbs = Join-Path $agentDir "start_agent.vbs"
        if (Test-Path $vbs) {
            Start-Process -FilePath "wscript.exe" -ArgumentList "`"$vbs`""
        } else {
            Start-Process -FilePath $pythonCmd -ArgumentList "agent.py" -WorkingDirectory $agentDir -WindowStyle Hidden
        }

        Write-Ok "Atualizacao concluida (v1.1.0)."
    } else {
        Write-Step "[1/5] Criando pasta $agentDir ..."
        New-Item -ItemType Directory -Force -Path $agentDir | Out-Null

        Write-Step "[2/5] Baixando agent..."
        Get-File "$github/agent.py" (Join-Path $agentDir "agent.py")
        Get-File "$github/system_info.py" (Join-Path $agentDir "system_info.py")
        Get-File "$github/requirements.txt" (Join-Path $agentDir "requirements.txt")
        if (Test-Path "$github/crypto_utils.py") {
            try { Get-File "$github/crypto_utils.py" (Join-Path $agentDir "crypto_utils.py") } catch { }
        }

        Write-Step "[3/5] Criando config.yaml..."
        $config = @"
agent_id: AUTO
agent_secret: $agentSecret
heartbeat_interval: 60
log_file: endpointx-agent.log
log_level: INFO
server_url: $serverUrl/api
"@
        Set-Content -Path (Join-Path $agentDir "config.yaml") -Value $config -Encoding utf8

        Write-Step "[4/5] Instalando dependencias (psutil, requests, pyyaml)..."
        & $pythonCmd -m pip install --disable-pip-version-check -q psutil requests pyyaml 2>$null

        Write-Step "[5/5] Registrando device..."
        Push-Location $agentDir
        try {
            & $pythonCmd agent.py --register
        } catch {
            Write-Info "Registro automatico pode falhar; o agent tentara novamente no arranque."
        } finally {
            Pop-Location
        }

        $vbsContent = @"
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "$agentDir"
WshShell.Run "pythonw.exe agent.py", 0, False
"@
        Set-Content -Path (Join-Path $agentDir "start_agent.vbs") -Value $vbsContent -Encoding ASCII -Force

        $startup = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup\endpointx.vbs"
        try { Copy-Item (Join-Path $agentDir "start_agent.vbs") $startup -Force } catch { }

        Start-Process -FilePath "wscript.exe" -ArgumentList "`"$(Join-Path $agentDir 'start_agent.vbs')`""
        Write-Ok "Instalacao concluida (v1.1.0). Agent em background + auto-start no login."
    }
} catch {
    Write-Err "Falha na instalacao: $($_.Exception.Message)"
    Write-Info "Verifique rede/permissoes e tente novamente."
}
