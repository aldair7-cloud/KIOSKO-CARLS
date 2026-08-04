@echo off
setlocal

REM Si el helper ya está activo, no iniciar una segunda copia.
curl.exe -fsS "http://127.0.0.1:5217/salud" | findstr /I /C:"ok" >nul
if not errorlevel 1 exit /b 0

REM Comprobar que Node.js está instalado.
where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: No se encontro Node.js.
  echo Instala Node.js y vuelve a ejecutar este archivo.
  pause
  exit /b 1
)

REM Iniciar print-helper.js oculto mediante el lanzador VBS.
start "" /b wscript.exe "%~dp0iniciar-impresora.vbs"

exit /b 0
