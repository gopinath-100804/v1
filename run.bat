@echo off
 

REM Run cloudflared tunnel (adjust URL and flags as needed)
cloudflared tunnel --url https://10.0.14.159 --no-tls-verify

REM Pause the window so it doesn't close immediately after cloudflared stops
pause
