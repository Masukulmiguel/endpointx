# EndpointX Agent Installer
# Safe for: irm https://.../install.ps1?t=<ENROLL_TOKEN> | iex
# Does NOT use exit/Read-Host/Set-Location (those break iex pipelines).

$serverUrl = "##SERVER_URL##"
$agentSecret = "##AGENT_SECRET##"
$enrollToken = "##ENROLL_TOKEN##"
$consentMode = "##CONSENT_MODE##"
# Injected by the server from endpoint-agent/agent.py (CURRENT_AGENT_VERSION).
$agentVersion = "##AGENT_VERSION##"
if ([string]::IsNullOrWhiteSpace($agentVersion) -or $agentVersion -like '*##*') {
    $agentVersion = 'Unknown'
}
$agentDir = "C:\endpointx\endpoint-agent"
$github = "https://raw.githubusercontent.com/Masukulmiguel/endpointx/main/endpoint-agent"
$ErrorActionPreference = "Continue"

# Consentimento nativo: pedido de instalacao criado na consola e ainda sem
# decisao web - pergunta ao utilizador antes de instalar qualquer coisa.
# (Nao usa exit/Read-Host - quebram pipelines irm|iex; usa return.)
if ($consentMode -eq "1") {
    Write-Host ""
    Write-Host "  Este computador foi detetado na rede pelo EndpointX." -ForegroundColor Yellow
    $choice = $null
    try {
        Add-Type -AssemblyName PresentationFramework
        $r = [System.Windows.MessageBox]::Show(
            "O administrador da rede pediu autorizacao para instalar o agente EndpointX neste computador ($env:COMPUTERNAME).`n`nO agente recolhe metricas de hardware, rede e software para gestao e seguranca do equipamento.`n`nAutoriza a instalacao?",
            "EndpointX - Pedido de instalacao",
            "YesNo", "Question")
        $choice = if ($r -eq "Yes") { "authorize" } else { "refuse" }
    } catch {
        try {
            $wshell = New-Object -ComObject WScript.Shell
            $r = $wshell.Popup("O administrador da rede pediu autorizacao para instalar o agente EndpointX neste computador. Autoriza a instalacao?", 0, "EndpointX - Pedido de instalacao", 4 + 32)
            $choice = if ($r -eq 6) { "authorize" } else { "refuse" }
        } catch {
            $choice = "refuse"
        }
    }
    try {
        Invoke-RestMethod -Uri "$serverUrl/api/enroll/decision" -Method Post -ContentType "application/json" -Body (@{ token = $enrollToken; decision = $choice } | ConvertTo-Json) -TimeoutSec 15 | Out-Null
    } catch { }
    if ($choice -ne "authorize") {
        Write-Host "  Instalacao recusada. Nada foi instalado neste computador." -ForegroundColor Red
        Write-Host ""
        return
    }
    Write-Host "  Consentimento registado. A instalar o agente..." -ForegroundColor Cyan
    Write-Host ""
}

function Write-Step($msg) { Write-Host $msg -ForegroundColor Green }
function Write-Info($msg) { Write-Host $msg -ForegroundColor Yellow }
function Write-Err($msg) { Write-Host $msg -ForegroundColor Red }
function Write-Ok($msg) { Write-Host $msg -ForegroundColor Cyan }
function Write-General($msg) { Write-Host $msg -ForegroundColor White }

# Banner ASCII EndpointX (figlet standard font, nome oficial: EndpointX)
$bannerLines = @(
    ' _____           _             _       _  __  __'
    '| ____|_ __   __| |_ __   ___ (_)_ __ | |_\ \/ /'
    '|  _| | ''_ \ / _` | ''_ \ / _ \| | ''_ \| __|\  / '
    '| |___| | | | (_| | |_) | (_) | | | | | |_ /  \ '
    '|_____|_| |_|\__,_| .__/ \___/|_|_| |_|\__/_/\_\'
    '                  |_|                           '
)

Write-Host ""
foreach ($line in $bannerLines) {
    Write-Host $line -ForegroundColor Blue
}
Write-Host "  EndpointX v$agentVersion" -ForegroundColor Cyan
Write-Host "  Agent Installation System" -ForegroundColor White
Write-Host "  Discover | Manage | Protect" -ForegroundColor White
if ($agentVersion -eq 'Unknown') {
    Write-Info "  AVISO: nao foi possivel determinar a versao do agente."
}
Write-Host "  Server: $serverUrl" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  EndpointX agent will be installed in background with auto-start." -ForegroundColor DarkGray
Write-Host ""

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch { }

# Python check (no exit - just fail soft for iex)
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
        Get-File "$github/discovery.py" (Join-Path $agentDir "discovery.py")
        Get-File "$github/agent.py" (Join-Path $agentDir "agent.py")
        Get-File "$github/system_info.py" (Join-Path $agentDir "system_info.py")
        try { Get-File "$github/remote.py" (Join-Path $agentDir "remote.py") } catch { }
        try { Get-File "$github/forensics.py" (Join-Path $agentDir "forensics.py") } catch { }
        try { Get-File "$github/requirements.txt" (Join-Path $agentDir "requirements.txt") } catch { }

        $reqPath = Join-Path $agentDir "requirements.txt"
        if ((Test-Path $reqPath) -and $pythonCmd) {
            & $pythonCmd -m pip install --disable-pip-version-check -q -r $reqPath 2>$null
        }

        Write-Step "[3/4] Atualizando config.yaml..."
        $config = @"
agent_id: AUTO
agent_secret: $agentSecret
enroll_token: $enrollToken
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

        Write-Ok "Atualizacao concluida (v$agentVersion)."
    } else {
        Write-Step "[1/5] Criando pasta $agentDir ..."
        New-Item -ItemType Directory -Force -Path $agentDir | Out-Null

        Write-Step "[2/5] Baixando agent..."
        Get-File "$github/discovery.py" (Join-Path $agentDir "discovery.py")
        Get-File "$github/agent.py" (Join-Path $agentDir "agent.py")
        Get-File "$github/system_info.py" (Join-Path $agentDir "system_info.py")
        Get-File "$github/requirements.txt" (Join-Path $agentDir "requirements.txt")
        try { Get-File "$github/remote.py" (Join-Path $agentDir "remote.py") } catch { }
        try { Get-File "$github/forensics.py" (Join-Path $agentDir "forensics.py") } catch { }
        if (Test-Path "$github/crypto_utils.py") {
            try { Get-File "$github/crypto_utils.py" (Join-Path $agentDir "crypto_utils.py") } catch { }
        }

        Write-Step "[3/5] Criando config.yaml..."
        $config = @"
agent_id: AUTO
agent_secret: $agentSecret
enroll_token: $enrollToken
heartbeat_interval: 60
log_file: endpointx-agent.log
log_level: INFO
server_url: $serverUrl/api
"@
        Set-Content -Path (Join-Path $agentDir "config.yaml") -Value $config -Encoding utf8

        Write-Step "[4/5] Instalando dependencias (psutil, requests, pyyaml, remote)..."
        & $pythonCmd -m pip install --disable-pip-version-check -q psutil requests pyyaml 2>$null
        $reqPath = Join-Path $agentDir "requirements.txt"
        if (Test-Path $reqPath) {
            & $pythonCmd -m pip install --disable-pip-version-check -q -r $reqPath 2>$null
        }

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
        Write-Ok "Instalacao concluida (v$agentVersion). Agent em background + auto-start no login."
    }
} catch {
    Write-Err "Falha na instalacao: $($_.Exception.Message)"
    Write-Info "Verifique rede/permissoes e tente novamente."
}
