@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo.
echo Установка бота Scrap Mechanic для группы scrapmehi.
echo Ключ ВК и ADMIN_SECRET должны быть уже сохранены в Cloudflare.
echo Этот файл не запрашивает и не сохраняет ваши ключи.
echo.

if not exist "worker.mjs" goto missing_files
if not exist "wrangler.jsonc" goto missing_files
where node >nul 2>&1
if errorlevel 1 goto missing_node
where npx.cmd >nul 2>&1
if errorlevel 1 goto missing_node
node -e "if (Number(process.versions.node.split('.')[0]) < 22) process.exit(1)"
if errorlevel 1 goto missing_node

echo Будет обновлено приложение scrapmehi-news в выбранном аккаунте Cloudflare.
echo Будут подключены память и проверка новостей раз в час.
echo Первый успешный запуск пропустит архив; затем начнут публиковаться новые новости.
echo Не запускайте вторую копию бота для той же группы.
echo.
choice /c YN /n /m "Продолжить установку? Y = да, N = нет: "
if errorlevel 2 goto cancelled
if errorlevel 1 goto login
goto cancelled

:login
echo.
echo Шаг 1 из 2. Вход в Cloudflare.
echo Откроется браузер. Проверьте аккаунт и разрешите доступ официальной утилите Wrangler.
call npx.cmd --yes wrangler@4.168.0 login
if errorlevel 1 goto failed

echo.
echo Шаг 2 из 2. Загрузка бота, подключение памяти и расписания.
echo Если появится выбор аккаунта, выберите тот, где уже создан scrapmehi-news.
echo Если утилита предупредит о замене кода из панели Cloudflare, это ожидаемо:
echo заменяем только заготовку Hello World. Секреты сохраняются.
call npx.cmd --yes wrangler@4.168.0 deploy --keep-vars
if errorlevel 1 goto failed

echo.
echo Загрузка завершена. Это ещё не подтверждение успешной работы API ВК.
echo Сохраните адрес workers.dev из результата выше.
echo Проверим состояние бота следующим шагом. Ключи в чат не отправляйте.
echo Расписание может примениться не сразу. Первый запуск не публикует архив.
echo.
pause
exit /b 0

:missing_node
echo.
echo Нужен Node.js версии 22 или новее. Рекомендуется текущая версия LTS.
echo Установите его с https://nodejs.org/ и заново откройте этот файл.
echo Существующий бот в Cloudflare не изменён.
echo.
pause
exit /b 1

:missing_files
echo.
echo Не найдены файлы worker.mjs и wrangler.jsonc рядом с установщиком.
echo Сначала распакуйте ВЕСЬ архив в отдельную папку и запустите файл из неё.
echo.
pause
exit /b 1

:failed
echo.
echo Установка не завершилась успешно. Не повторяйте её вслепую.
echo Сохраните текст ошибки выше и покажите помощнику, скрыв личные данные.
echo Не отправляйте ключи или ссылки авторизации из браузера.
echo При сбое загрузки приложение могло обновиться частично: сначала проверим его состояние.
echo.
pause
exit /b 1

:cancelled
echo Установка отменена.
pause
exit /b 0
