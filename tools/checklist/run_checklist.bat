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
REM Drag-and-drop wraps paths in quotes. Strip them straight after each answer and test with
REM !VAR! (only when an answer was given; on an empty one the substitution leaves junk): a quoted path with spaces inside if "%VAR%"=="" is a syntax error that closes the window.
set WO=
set /p WO=  Work order number (e.g. P-26-1007-018p): 
if defined WO set "WO=!WO:"=!"
if "!WO!"=="" ( echo   No work order given. Nothing to do. & pause & exit /b 1 )

REM Find the RECSET and the job's 04_PRODUCTION folder from the WO (find_recset.py). Anything it
REM can't find, or the PM wants to change, is asked for: drag a file or folder in.
echo.
echo   Looking up the work order...
set RECSET=
set OUT=
type nul > "%TEMP%\sp_recset.txt"
type nul > "%TEMP%\sp_out.txt"
%PY% "%~dp0find_recset.py" "!WO!" "%TEMP%\sp_recset.txt" "%TEMP%\sp_out.txt" || ( echo   Could not look up the work order - see the message above. & pause & exit /b 1 )
set /p RECSET=<"%TEMP%\sp_recset.txt"
set /p OUT=<"%TEMP%\sp_out.txt"

echo.
if defined RECSET (
  echo   Press Enter to use that RECSET, or drag a different one into this window.
) else (
  echo   Drag the RECSET shop drawing PDF into this window, then press Enter.
  echo   ^(Leave blank to skip - materials, finishes and Drawn By will be left empty.^)
)
set OTHER=
set /p OTHER=  RECSET: 
if defined OTHER set "OTHER=!OTHER:"=!"
if defined OTHER set "RECSET=!OTHER!"

if not defined OUT (
  echo.
  echo   Drag the job's 04_PRODUCTION folder into this window, then press Enter.
  set /p OUT=  Output folder: 
  if defined OUT set "OUT=!OUT:"=!"
)
if "!OUT!"=="" ( echo   No output folder given. Nothing to do. & pause & exit /b 1 )

REM VIF and engineering sign-off: numbered lists from SP's checklist/settings.json ("choices").
set VIF=
%PY% "%~dp0pick_person.py" vif "%TEMP%\sp_vif.txt" || ( echo   Could not read the names list. & pause & exit /b 1 )
set /p VIF=<"%TEMP%\sp_vif.txt"

set ENG=
%PY% "%~dp0pick_person.py" eng_signoff "%TEMP%\sp_eng.txt" || ( echo   Could not read the names list. & pause & exit /b 1 )
set /p ENG=<"%TEMP%\sp_eng.txt"

REM --- write the intake file ---------------------------------------
> "%TEMP%\sp_intake.json" echo {"vif": "!VIF!", "eng_signoff": "!ENG!"}

REM --- run ----------------------------------------------------------
echo.
echo   Working...
echo.
if "!RECSET!"=="" (
  %PY% "%~dp0make_checklist.py" "!WO!" --intake "%TEMP%\sp_intake.json" --out "!OUT!"
) else (
  %PY% "%~dp0make_checklist.py" "!WO!" --recset "!RECSET!" --intake "%TEMP%\sp_intake.json" --out "!OUT!"
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
