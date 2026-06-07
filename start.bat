@echo off
echo =========================================
echo   Omni-Orchestrator
echo =========================================

:: Activate venv
call venv\Scripts\activate.bat

:: Start backend
echo Starting backend on http://127.0.0.1:8000 ...
cd backend
start "Omni-Orchestrator Backend" cmd /c "..\venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000"
cd ..

:: Wait for server
timeout /t 2 /nobreak > nul

:: Open frontend
echo Opening Web UI...
start "" "frontend\index.html"

echo.
echo Backend running in separate window. Close that window to stop the server.
pause
