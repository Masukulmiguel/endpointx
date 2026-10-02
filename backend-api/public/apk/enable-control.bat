@echo off
rem EndpointX - instala o agente Android e ativa o controlo remoto num so passo.
rem Requer: adb (Android platform-tools) no PATH e telemovel ligado com depuracao USB.
setlocal
set APP=pt.endpointx.agent
set SERVER=https://endpointx.onrender.com
set APK=%~dp0endpointx-agent.apk

where adb >nul 2>&1
if errorlevel 1 (
  echo [ERRO] adb nao encontrado. Instale os Android platform-tools e volte a correr.
  exit /b 1
)

if not exist "%APK%" (
  echo A descarregar o APK do servidor...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri '%SERVER%/api/devices/public/endpointx-agent.apk' -OutFile '%APK%'" >nul 2>&1
  if not exist "%APK%" (
    echo [ERRO] Nao foi possivel descarregar o APK. Coloque endpointx-agent.apk junto deste script.
    exit /b 1
  )
)

echo A instalar o agente...
adb install -r "%APK%"
if errorlevel 1 (
  echo [ERRO] Instalacao falhou - confirme o telemovel ligado e a depuracao USB ativa.
  exit /b 1
)

echo A conceder a permissao que permite ativar o controlo sem menus...
adb shell pm grant %APP% android.permission.WRITE_SECURE_SETTINGS
adb shell settings put secure enabled_accessibility_services %APP%/.ControlService
adb shell settings put secure accessibility_enabled 1

echo.
echo Pronto - controlo remoto ATIVO sem ter de passar pelas definicoes do Android.
echo Abra a app EndpointX no telemovel para concluir o registo.
endlocal
exit /b 0
