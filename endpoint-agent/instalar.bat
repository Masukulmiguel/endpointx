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

REM Criar script de inicio
echo Criando script de inicio...
echo @echo off > C:\endpointx\endpoint-agent\iniciar.bat
echo cd /d C:\endpointx\endpoint-agent >> C:\endpointx\endpoint-agent\iniciar.bat
echo python agent.py >> C:\endpointx\endpoint-agent\iniciar.bat

REM Criar tarefa agendada para iniciar com o Windows (nao precisa de login)
echo Criando tarefa agendada...
schtasks /create /tn "EndpointX Agent" /tr "\"C:\endpointx\endpoint-agent\iniciar.bat\"" /sc onstart /ru SYSTEM /f

REM Iniciar agent agora
echo Iniciando agent...
cd /d C:\endpointx\endpoint-agent
start /b python agent.py

echo.
echo ========================================
echo Instalacao concluida!
echo O agent vai iniciar automaticamente 
echo sempre que o PC for ligado.
echo ========================================
pause
