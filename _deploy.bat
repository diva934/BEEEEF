@echo off
echo === BEEEF Deploy - Push vers GitHub ===
cd /d C:\Users\pierr\Downloads\BEEF

echo Suppression du lock git...
if exist .git\index.lock del /f .git\index.lock

echo.
echo Etat du repo:
git log --oneline -3
echo.

echo Push vers GitHub (diva934/BEEEEF)...
git push origin main

echo.
if %ERRORLEVEL% == 0 (
  echo ===================================================
  echo  SUCCESS! Railway et Vercel deploient maintenant.
  echo  Surveille Railway Dashboard pour voir le build.
  echo ===================================================
) else (
  echo ===================================================
  echo  ERREUR - Le push a echoue.
  echo  Verifie que tu es connecte a GitHub.
  echo  (git credential manager doit avoir tes identifiants)
  echo ===================================================
)
pause
