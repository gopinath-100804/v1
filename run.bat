@echo off
REM Start Node.js server in the background
start "" cmd /k "node server.js"

REM Wait a few seconds to let the server start up (adjust if needed)
timeout /t 5 /nobreak > nul

REM Run cloudflared tunnel (adjust URL and flags as needed)
cloudflared tunnel --url https://localhost:3000 --no-tls-verify

REM Pause the window so it doesn't close immediately after cloudflared stops
pause
