@echo off
 

REM Run cloudflared tunnel (adjust URL and flags as needed)
cloudflared tunnel --url https://localhost --no-tls-verify

REM Pause the window so it doesn't close immediately after cloudflared stops
pause
