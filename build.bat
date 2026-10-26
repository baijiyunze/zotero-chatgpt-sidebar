@echo off
rem Build the xpi and regenerate update.json.
rem Usage: double-click, or: build.bat <github-owner> [repo]

setlocal enabledelayedexpansion
cd /d "%~dp0"

set "OWNER=%~1"
set "REPO=%~2"
if "%REPO%"=="" set "REPO=zotero-chatgpt-sidebar"

if "%OWNER%"=="" set /p OWNER=GitHub owner (username): 
if "%OWNER%"=="" (
  echo [ERROR] owner is required
  pause
  exit /b 1
)

where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] python not found in PATH
  pause
  exit /b 1
)

python build.py --owner "%OWNER%" --repo "%REPO%"
if errorlevel 1 (
  echo [ERROR] build failed
  pause
  exit /b 1
)

echo.
echo Output: dist\ and update.json
echo Next  : upload changed source files + update.json, then create a GitHub Release
pause
