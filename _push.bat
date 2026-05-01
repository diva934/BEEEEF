@echo off
cd /d "%~dp0"
if exist .git\index.lock del /f /q .git\index.lock
if exist .git\index del /f /q .git\index
git reset
git add -A
git commit -m "fix: courbe graphique non-plate via enrichissement O-U deterministique frontend"
git push origin main --force
echo.
git log --oneline -3
pause
