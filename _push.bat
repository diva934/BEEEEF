@echo off
cd /d "%~dp0"
if exist .git\index.lock del /f /q .git\index.lock
if exist .git\index del /f /q .git\index
git reset
git add -A
git commit -m "feat: countdown timer + auto-settlement + historique synthetique realiste sur le graphique"
git push origin main --force
echo.
git log --oneline -3
pause
