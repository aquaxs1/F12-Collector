@echo off
REM F12 Collector - offline security checker (Windows launcher).
REM Double-click this file and drag a ZIP onto it, or run it and paste the path when asked.
REM It runs "python check.py <zip>" and opens the HTML report at the end.

setlocal
cd /d "%~dp0"

REM Find a Python interpreter (py launcher preferred, then python).
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (
  where python >nul 2>nul && set "PY=python"
)
if not defined PY (
  echo.
  echo Python 3 was not found. Install it from https://www.python.org/downloads/
  echo and make sure "Add python.exe to PATH" is ticked.
  echo.
  pause
  exit /b 1
)

set "INPUT=%~1"
if "%INPUT%"=="" (
  echo.
  echo F12 Collector - Security Checker
  echo --------------------------------
  set /p "INPUT=Drag the F12 Collector ZIP here (or paste its path) and press Enter: "
)

REM Strip surrounding quotes if present.
set "INPUT=%INPUT:"=%"

if "%INPUT%"=="" (
  echo No input given.
  pause
  exit /b 1
)

echo.
echo Analysing "%INPUT%" ...
%PY% "%~dp0check.py" "%INPUT%" --open
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
  echo Checker exited with code %RC%.
)
pause
exit /b %RC%
