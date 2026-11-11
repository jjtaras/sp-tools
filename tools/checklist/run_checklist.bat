@echo off
REM ===================================================================
REM  Production Checklist generator - Studio Practice
REM  Double-click this file. It asks a few questions and writes the
REM  finished checklist into the job's 04_PRODUCTION folder.
REM
REM  Lives in sp-tools\tools\checklist. Settings come from the repo .env
REM  (INNERGY_API_KEY, SP_CONFIG_DIR) and SP's sp-tools-config\checklist.
REM ===================================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

REM --- find Python -------------------------------------------------
set PY=
where py >nul 2>&1 && set PY=py
if "%PY%"=="" ( where python >nul 2>&1 && set PY=python )
if "%PY%"=="" (
  echo.
  echo   Python is not installed, or not on your PATH.
  echo   Install it from https://www.python.org/downloads/
  echo   and tick "Add python.exe to PATH" during setup.
  echo.
  pause
  exit /b 1
)

echo.
echo   ===============================================
echo    Production Checklist generator
echo   ===============================================
echo.

REM --- inputs ------------------------------------------------------
set /p WO=  Work order number (e.g. P-26-1007-018p):
if "%WO%"=="" ( echo   No work order given. Nothing to do. & pause & exit /b 1 )

echo.
echo   Drag the RECSET shop drawing PDF into this window, then press Enter.
echo   (Leave blank to skip - materials and Drawn By will be left empty.)
set /p RECSET=  RECSET:

echo.
echo   Drag the job's 04_PRODUCTION folder into this window, then press Enter.
set /p OUT=  Output folder:
if "%OUT%"=="" ( echo   No output folder given. Nothing to do. & pause & exit /b 1 )

echo.
set /p VIF=  VIF - who verified in field (Enter for the SP default):

set /p ENG=  Engineering sign off (Enter for the SP default):

REM --- strip quotes that drag-and-drop adds ------------------------
set RECSET=!RECSET:"=!
set OUT=!OUT:"=!

REM --- write the intake file ---------------------------------------
> "%TEMP%\sp_intake.json" echo {"vif": "!VIF!", "eng_signoff": "!ENG!"}

REM --- run ----------------------------------------------------------
echo.
echo   Working...
echo.
if "!RECSET!"=="" (
  %PY% "%~dp0make_checklist.py" "%WO%" --intake "%TEMP%\sp_intake.json" --out "!OUT!"
) else (
  %PY% "%~dp0make_checklist.py" "%WO%" --recset "!RECSET!" --intake "%TEMP%\sp_intake.json" --out "!OUT!"
)

if errorlevel 1 (
  echo.
  echo   Something went wrong - see the message above.
  echo   Most common causes: no internet, a bad work order number,
  echo   or the Python packages are not installed yet. To install them:
  echo.
  echo      %PY% -m pip install -r "%~dp0requirements.txt"
  echo.
) else (
  echo.
  echo   Done. The checklist is in:
  echo      !OUT!
  echo.
  echo   Check the CNC Blanks line before sending it to the shop -
  echo   it defaults to NONE and cut sizes cannot be read off the drawing.
  echo.
)

pause
endlocal
