@echo off
cd /d "%~dp0"
if exist .git\index.lock del /f /q .git\index.lock
if exist .git\index del /f /q .git\index
git reset
git add -A
git commit -m "feat: graphique vrai historique + hero image article + bots misent sur le marche"
git push origin main --force
echo.
git log --oneline -3
pause
