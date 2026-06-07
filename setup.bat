@echo off
echo ============================================
echo   Omni-Orchestrator Setup
echo ============================================
echo.

:: Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found. Install Python 3.11+ first.
    pause
    exit /b 1
)

:: Check Node.js
node --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found. Install Node.js 18+ first.
    pause
    exit /b 1
)

:: Create venv
if not exist "venv\Scripts\python.exe" (
    echo [1/4] Creating Python virtual environment...
    python -m venv venv
)

:: Activate venv and install Python deps
echo [2/4] Installing Python dependencies...
call venv\Scripts\activate.bat
python -m pip install -r requirements.txt --quiet

:: Install Node.js deps for backend PTY bridge
echo [3/4] Installing Node.js dependencies...
cd backend
call npm install --silent
cd ..

:: Done
echo [4/4] Setup complete!
echo.
echo ============================================
echo   Run the application:
echo     start.bat
echo ============================================
pause
