@echo off
cd /d C:\endpointx\endpoint-agent

echo ========================================
echo Instalando EndpointX Agent...
echo ========================================

REM Verificar se Python esta instalado
python --version >nul 2>&1
if errorlevel 1 (
    echo ERRO: Python nao encontrado!
    pause
    exit /b 1
)

REM Instalar dependencias
echo Instalando dependencias...
pip install psutil requests pyyaml

REM Registar agent
echo Registando device no servidor...
python agent.py --register

REM Parar agent antigo se existir
taskkill /f /im pythonw.exe 2>nul
taskkill /f /im python.exe /fi "WINDOWTITLE eq *agent*" 2>nul

REM Criar script VBS para rodar invisivelmente em background
echo Criando script de background...
echo Set WshShell = CreateObject("WScript.Shell") > C:\endpointx\endpoint-agent\start_agent.vbs
echo WshShell.CurrentDirectory = "C:\endpointx\endpoint-agent" >> C:\endpointx\endpoint-agent\start_agent.vbs
echo WshShell.Run "pythonw.exe agent.py", 0, False >> C:\endpointx\endpoint-agent\start_agent.vbs

REM Criar tarefa agendada para iniciar com o Windows
echo Criando tarefa agendada...
schtasks /delete /tn "EndpointX Agent" /f 2>nul
schtasks /create /tn "EndpointX Agent" /tr "wscript.exe \"C:\endpointx\endpoint-agent\start_agent.vbs\"" /sc onstart /ru SYSTEM /f

REM Iniciar agent agora
echo Iniciando agent...
wscript.exe "C:\endpointx\endpoint-agent\start_agent.vbs"

timeout /t 3 >nul

echo.
echo ========================================
echo Instalacao concluida!
echo O agent esta a correr em background.
echo Vai iniciar automaticamente ao ligar PC.
echo ========================================
pause
