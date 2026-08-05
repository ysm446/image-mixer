@echo off
setlocal

set "PROJECT_DIR=%~dp0"
set "VENV_PYTHON=%PROJECT_DIR%.venv\Scripts\python.exe"
set "PACKAGE_FILE=%PROJECT_DIR%package.json"
set "NODE_MODULES=%PROJECT_DIR%node_modules"

pushd "%PROJECT_DIR%" >nul 2>&1
if errorlevel 1 (
  echo [Image Mixer] Could not open the project directory.
  pause
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  echo [Image Mixer] Node.js was not found in PATH.
  goto :error
)

where npm >nul 2>&1
if errorlevel 1 (
  echo [Image Mixer] npm was not found in PATH.
  goto :error
)

if not exist "%PACKAGE_FILE%" (
  echo [Image Mixer] package.json was not found.
  goto :error
)

if not exist "%NODE_MODULES%" (
  echo [Image Mixer] node_modules was not found. Run npm install first.
  goto :error
)

if not exist "%VENV_PYTHON%" (
  echo [Image Mixer] .venv was not found. Create the Python environment first.
  goto :error
)

echo [Image Mixer] Starting the application...
echo [Image Mixer] ComfyUI will start and stop automatically on port 8189.
call npm run dev
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo [Image Mixer] The application exited with code %EXIT_CODE%.
  pause
)

popd
exit /b %EXIT_CODE%

:error
echo.
echo [Image Mixer] Startup checks failed.
pause
popd
exit /b 1
