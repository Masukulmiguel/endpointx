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

REM Criar script VBS para rodar invisivelmente em background
echo Criando script de background...
echo Set WshShell = CreateObject("WScript.Shell") > "C:\endpointx\endpoint-agent\start_agent.vbs"
echo WshShell.CurrentDirectory = "C:\endpointx\endpoint-agent" >> "C:\endpointx\endpoint-agent\start_agent.vbs"
echo WshShell.Run "pythonw.exe agent.py", 0, False >> "C:\endpointx\endpoint-agent\start_agent.vbs"

REM Copiar VBS para pasta de inicio do Windows (inicia com login)
echo Configurando auto-start...
mkdir "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup" 2>nul
copy /Y "C:\endpointx\endpoint-agent\start_agent.vbs" "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\endpointx.vbs" >nul

REM Iniciar agent agora
echo Iniciando agent...
wscript.exe "C:\endpointx\endpoint-agent\start_agent.vbs"

timeout /t 3 >nul

echo.
echo ========================================
echo Instalacao concluida!
echo O agent esta a correr em background.
echo Vai iniciar automaticamente ao ligar.
echo ========================================
pause
