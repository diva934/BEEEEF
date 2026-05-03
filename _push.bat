@echo off
cd /d "%~dp0"

echo.
echo ╔══════════════════════════════════════════════╗
echo ║  BEEEF — Migration + Deploy                  ║
echo ╚══════════════════════════════════════════════╝
echo.

echo [1/2] Migration Supabase (debate_history)...
node _migrate.js
if %ERRORLEVEL% NEQ 0 (
  echo.
  echo ERREUR migration — deploy annule.
  pause
  exit /b 1
)

echo.
echo [2/2] Push Git vers Render...
if exist .git\index.lock del /f /q .git\index.lock
if exist .git\index del /f /q .git\index
git reset
git add -A
git commit -m "fix: graph shows real backend history for ALL debates including crypto"
git push origin main --force
echo.
git log --oneline -3
echo.
echo Deploiement lance sur Railway. Attends ~2 min puis recharge le site.
pause
