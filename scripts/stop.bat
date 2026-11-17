@echo off
rem Paragem local do HyperRadar (Windows; pode ser aberto com duplo clique).
rem Servidor: encerramento limpo; Postgres: docker compose stop (os dados são mantidos).
setlocal
for /f "tokens=2 delims=:." %%c in ('chcp') do set "HR_CP=%%c"
chcp 65001 >nul
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo [HyperRadar] Erro: Node.js não encontrado.
  goto :erro
)

node scripts\local.mjs parar
if errorlevel 1 goto :erro
chcp %HR_CP% >nul
exit /b 0

:erro
if not "%HYPERRADAR_NO_PAUSE%"=="1" pause
chcp %HR_CP% >nul
exit /b 1
