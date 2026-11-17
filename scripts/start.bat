@echo off
rem Arranque local do HyperRadar (Windows; pode ser aberto com duplo clique).
rem A logica esta em scripts\local.mjs; aqui so se verifica o Node.js.
setlocal
for /f "tokens=2 delims=:." %%c in ('chcp') do set "HR_CP=%%c"
chcp 65001 >nul
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo [HyperRadar] Erro: Node.js não encontrado. Instale o Node.js 22 ou superior ^(https://nodejs.org/^).
  goto :erro
)
for /f "tokens=1 delims=." %%v in ('node -v') do set "HR_NODE=%%v"
set "HR_NODE=%HR_NODE:v=%"
if %HR_NODE% LSS 22 (
  echo [HyperRadar] Erro: é necessário o Node.js 22 ou superior.
  goto :erro
)

node scripts\local.mjs iniciar
if errorlevel 1 goto :erro
chcp %HR_CP% >nul
exit /b 0

:erro
rem Mantém a janela aberta (duplo clique) para se ler o erro; HYPERRADAR_NO_PAUSE=1 desativa.
if not "%HYPERRADAR_NO_PAUSE%"=="1" pause
chcp %HR_CP% >nul
exit /b 1
