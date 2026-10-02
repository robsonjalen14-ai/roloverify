@echo off
REM Rolo Verify — localhost starter. double-click this. no ceremony.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [rolo] node not found. install node 20+ from nodejs.org, then re-run.
  pause
  exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo [rolo] node %%v

if not exist ".env" (
  echo [rolo] no .env — copying example.
  copy ".env.example" ".env" >nul
)

if not exist "node_modules" (
  echo [rolo] first run — installing deps...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [rolo] npm install failed. check your connection.
    pause
    exit /b 1
  )
)

REM already up? double-clicked twice, or an old window still runs — reuse it.
curl.exe -s -m 3 http://localhost:3000/api/health >nul 2>nul
if not errorlevel 1 (
  echo [rolo] already running on http://localhost:3000 — opening browser.
  start "" "http://localhost:3000"
  echo [rolo] done. close the roloverify-server window to stop.
  pause
  exit /b 0
)

echo [rolo] starting Rolo Verify on http://localhost:3000 ...
start "roloverify-server" /d "%~dp0" cmd /k node server.js

REM wait for server to answer /api/health (max ~15s)
set /a tries=0
:wait
set /a tries+=1
curl.exe -s http://localhost:3000/api/health >nul 2>nul
if errorlevel 1 (
  if %tries% GEQ 15 (
    echo [rolo] server never answered. read the red text in the roloverify-server window.
    echo [rolo] if it says EADDRINUSE, port 3000 is busy — close other server windows and re-run.
    pause
    exit /b 1
  )
  timeout /t 1 /nobreak >nul
  goto wait
)

echo [rolo] up. opening browser.
start "" "http://localhost:3000"

REM optional bot: only if token looks real (not test_ placeholder)
findstr /c:"test_local_token" ".env" >nul 2>nul
if errorlevel 1 (
  echo [rolo] real bot token found — starting bot too.
  start "roloverify-bot" /d "%~dp0" cmd /k node bot.js
) else (
  echo [rolo] test token in .env — bot skipped. put a real DISCORD_BOT_TOKEN in .env to also run the bot.
)

echo [rolo] done. leave the server window open. close it to stop.
pause
