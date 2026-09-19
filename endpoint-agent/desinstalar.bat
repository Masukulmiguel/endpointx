@echo off
echo ========================================
echo Removendo EndpointX Agent...
echo ========================================

REM Parar agent
taskkill /f /im python.exe /fi "WINDOWTITLE eq *agent*" 2>nul

REM Remover tarefa agendada
schtasks /delete /tn "EndpointX Agent" /f 2>nul

REM Remover script de inicio
del iniciar.bat 2>nul

echo.
echo Agent removido com sucesso!
pause
