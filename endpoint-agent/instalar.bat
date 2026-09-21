@echo off
cd /d C:\endpointx\endpoint-agent

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

REM Criar script de inicio (vbs para correr em background silencioso)
echo Criando script de inicio...
echo Set WshShell = CreateObject("WScript.Shell") > C:\endpointx\endpoint-agent\iniciar.vbs
echo WshShell.Run "cmd /c cd /d C:\endpointx\endpoint-agent && python agent.py", 0, False >> C:\endpointx\endpoint-agent\iniciar.vbs

REM Criar tarefa agendada para iniciar com o Windows
echo Criando tarefa agendada...
schtasks /delete /tn "EndpointX Agent" /f 2>nul
schtasks /create /tn "EndpointX Agent" /tr "wscript.exe \"C:\endpointx\endpoint-agent\iniciar.vbs\"" /sc onstart /ru SYSTEM /f

REM Iniciar agent agora (em background)
echo Iniciando agent...
start /min cmd /c "cd /d C:\endpointx\endpoint-agent && python agent.py"

echo.
echo ========================================
echo Instalacao concluida!
echo O agent vai iniciar automaticamente 
echo sempre que o PC for ligado.
echo ========================================
pause
