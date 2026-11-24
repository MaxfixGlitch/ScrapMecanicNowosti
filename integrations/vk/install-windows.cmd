@echo off
setlocal
cd /d "%~dp0"

echo.
echo Scrap Mechanic news bot installer for scrapmehi.
echo VK_TOKEN and ADMIN_SECRET must already be saved in Cloudflare.
echo This installer does not ask for or save these secrets.
echo.

if not exist "worker.mjs" goto missing_files
if not exist "wrangler.jsonc" goto missing_files
where node >nul 2>&1
if errorlevel 1 goto missing_node
where npx.cmd >nul 2>&1
if errorlevel 1 goto missing_node
node -e "if (Number(process.versions.node.split('.')[0]) < 22) process.exit(1)"
if errorlevel 1 goto missing_node

echo This will replace Hello World in your existing scrapmehi-news Worker.
echo It will connect storage and enable an hourly news check.
echo The first successful run skips the archive. Later runs publish NEW news.
echo Do not install a second copy for the same VK group.
echo.
choice /c YN /n /m "Continue? Y = yes, N = no: "
if errorlevel 2 goto cancelled
if errorlevel 1 goto login
goto cancelled

:login
echo.
echo Step 1 of 2: Sign in to Cloudflare.
echo A browser will open. Check your account and authorize the official Wrangler CLI.
call npx.cmd --yes wrangler@4.168.0 login
if errorlevel 1 goto failed

echo.
echo Step 2 of 2: Upload code, connect storage and enable the schedule.
echo If asked, choose the account containing scrapmehi-news.
echo A warning about replacing dashboard code is expected for Hello World.
echo Do not replace any other important code. Existing secrets are preserved.
call npx.cmd --yes wrangler@4.168.0 deploy --keep-vars
if errorlevel 1 goto failed

echo.
echo Upload complete. VK posting still needs to be verified.
echo Save the workers.dev URL shown above.
echo Show the result to your helper, but never share secrets or authorization URLs.
echo The schedule may take time to activate. The first run skips the archive.
echo.
pause
exit /b 0

:missing_node
echo.
echo ERROR: Node.js 22 or newer with npm is required. Current LTS is recommended.
echo Install it from https://nodejs.org/ and open this installer again.
echo No Cloudflare changes were made by this run.
echo.
pause
exit /b 1

:missing_files
echo.
echo ERROR: worker.mjs or wrangler.jsonc is missing next to this installer.
echo Extract ALL files from the ZIP first, then run the extracted installer.
echo.
pause
exit /b 1

:failed
echo.
echo ERROR: Installation did not finish successfully. Do not retry blindly.
echo Show the error above to your helper. Hide personal details and secrets.
echo Never share browser authorization URLs.
echo A failed deployment may have applied some changes. Check the state first.
echo.
pause
exit /b 1

:cancelled
echo Installation cancelled.
pause
exit /b 0
