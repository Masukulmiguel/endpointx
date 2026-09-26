# EndpointX Agent Quick Update v1.1.0
# Safe for: irm https://.../update.ps1 | iex

$agentDir = "C:\endpointx\endpoint-agent"
$github = "https://raw.githubusercontent.com/Masukulmiguel/endpointx/main/endpoint-agent"
$ErrorActionPreference = "Continue"

function Write-Err($msg) { Write-Host $msg -ForegroundColor Red }
function Write-Ok($msg) { Write-Host $msg -ForegroundColor Cyan }

function Write-Banner($lines, $width) {
    $bar = "  +" + ("-" * $width) + "+"
    Write-Host $bar -ForegroundColor DarkCyan
    foreach ($l in $lines) {
        $text = [string]$l.Text
        $pad = $width - $text.Length
        if ($pad -lt 0) { $pad = 0 }
        $left = [int][math]::Floor($pad / 2)
        $right = $pad - $left
        Write-Host ("  |" + (" " * $left) + $text + (" " * $right) + "|") -ForegroundColor $l.Color
    }
    Write-Host $bar -ForegroundColor DarkCyan
}

# Logotipo EndpointX (formiga) em ASCII
$antLogo = @(
    '                          \     /',
    '                           \   /',
    '                            \ /',
    ' .---------.               .----.',
    '/           \  .-------.   (  o )',
    '|           |  /       \___|    |',
    '|           |..|       |   \    /',
    '|           |  \       /   ''----''',
    '\           /  ''-------''',
    ' ''---------''    /  |  \',
    '               /   |   \',
    '              /    |    \'
)
$antWidth = ($antLogo | ForEach-Object { $_.Length } | Measure-Object -Maximum).Maximum

Write-Host ""
Write-Banner @(
    $antLogo | ForEach-Object { @{ Text = $_.PadRight($antWidth); Color = 'Cyan' } }
    @{ Text = ('-' * 46); Color = 'DarkCyan' }
    @{ Text = 'E N D P O I N T X'; Color = 'Cyan' }
    @{ Text = 'AGENT QUICK UPDATE  v1.1.0'; Color = 'Gray' }
) 46
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
