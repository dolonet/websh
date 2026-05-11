# <img src="assets/websh-logo.svg" alt="" width="56" height="56" align="absmiddle"> websh

[English](README.md) | **Русский**

SSH-терминал в браузере. Обычный HTTP, без сборки, без отдельных сервисов.

- 📦 Без npm, без pip — кладёшь файлы и запускаешь
- 🌐 Корпоративные сети, где открыт только HTTPS: работает без WebSocket
- ⭐ Сессия живёт после закрытия вкладки, перезагрузки и рестарта бэкенда — до 72 ч (через tmux на удалённом хосте)

![websh split panes](screenshot.png)

```
┌─ Your browser ─┐    HTTPS     ┌── websh host ──┐     SSH      ┌──── Remote ────┐
│                │              │                │              │                │
│    xterm.js    │─── POST ────►│   server.py    │◄────────────►│      bash      │
│                │◄─── SSE ─────│    (Python)    │              │     + tmux     │
│                │              │                │              │                │
└────────────────┘              └────────────────┘              └────────────────┘
```

## Как это работает

Три части:

- **Браузер.** xterm.js рисует терминал. Каждое нажатие летит POST-ом на `/api/input`.
- **websh-хост.** `server.py` держит каждое SSH-подключение как PTY-подпроцесс и стримит вывод обратно через Server-Sent Events на `/api/stream`. Тот же процесс отдаёт фронтенд — отдельный веб-сервер не нужен.
- **Удалённый хост.** Куда ты заходишь по SSH. По желанию оборачивается в tmux, чтобы сессия пережила переподключение.

Если прокси буферизирует SSE (бывает на shared-хостинге), клиент переключается на long-polling по `/api/output` для этой сессии. Медленнее, но работает.

Shared-хостинг не даёт держать долгоживущий процесс? Положи `api.php` рядом с `server.py`. PHP-shim запустит бэкенд при первом запросе и будет проксировать API-вызовы к нему.

**Почему не WebSocket?** Многие shared-хостинги его не проксируют — websh должен работать и там. SSE даёт ту же низкую задержку поверх обычного HTTP и проходит через любой HTTPS-прокси без апгрейда протокола.

Глубже про устройство — детектор буферизации, защита от потери байт при дисконнекте, ожидание через selectors — см. [`docs/sse-transport.md`](docs/sse-transport.md).

## Требования

- **Бэкенд.** Python 3.5+ с `ssh` в PATH. Только stdlib — никаких pip-зависимостей.
- **Браузер.** Любой современный. xterm.js грузится с CDN.
- **Опциональный proxy на shared-хостинге.** PHP 5.3+ с расширением `curl`.
- **Опциональный reverse-proxy.** nginx, Caddy или Apache.

## Особенности

### 🖥️ Терминал

Настоящий xterm.js — копирование выделением, вставка правой кнопкой, поиск по скроллбэку (`Ctrl+Shift+F`), масштаб (`Ctrl+±`), полноэкранный режим (`F11`).

- Разделение на панели, горизонтально и вертикально, с перетаскиваемыми разделителями
- Переключение панелей: `Ctrl+Tab` / `Ctrl+Shift+Tab`
- Выбор шрифта (⚙) с живым предпросмотром — JetBrains Mono, Fira Code, IBM Plex Mono, Roboto Mono, Source Code Pro, Inconsolata или системный. Кастомный размер, межстрочный, начертание

### 🔁 Постоянные сессии

Поставь галочку **Persistent session** при подключении — websh обернёт shell в tmux-сессию на удалённом хосте. Закрой вкладку, перезагрузи компьютер, перезапусти `server.py`: панель переподключится к той же tmux-сессии со скроллбэком и работающими процессами. См. [`docs/persistent-sessions.md`](docs/persistent-sessions.md).

- Кнопка реконнекта при разрыве; красный баннер при auth-fail
- URL-якоря (`#connect=Production`) для прямых ссылок и закладок
- Сохранённые подключения в `localStorage` браузера

### 📁 Передача файлов

Загрузка и скачивание без `scp`.

- **Загрузка.** Выбираешь файлы; браузер стримит байты через пиггибэк-канал SSH ControlMaster (`cat > $HOME/<tmp>` без PTY, без base64, один POST на файл). На постоянных (tmux) панелях файл попадает в `pane_current_path` автоматически — vim/less/htop в фоне не дёргаются. Не-постоянные панели набирают `mv` в активный шелл с защитой от alt-screen. Авто-инкремент при коллизии имён. Прогресс через xhr.upload, очередь, отмена в полёте.
- **Скачивание.** Выделяешь имя файла в терминале, нажимаешь Download.
- **Экспорт скроллбэка.** Сохраняет текущий буфер в текстовый файл. На постоянных панелях берёт реальный tmux-скроллбэк через `tmux capture-pane`.

### 🔐 Профили подключений

От свободного «введи хост и поехали» до строго ограниченного click-to-connect. См. [`docs/server-side-connections.md`](docs/server-side-connections.md).

- Аутентификация по паролю и SSH-ключу
- Серверные профили в `websh.json` — креды остаются на сервере, браузер их не видит
- Два типа: **Ready** (сохранённые креды) и **Prompt** (целевой хост из allowlist, пользователь сам вводит пароль)
- `allowed_users` / `denied_users` для каждого профиля
- SSH-опции для отдельных профилей (`ProxyJump`, `StrictHostKeyChecking`, …)
- `restrict_hosts: true` полностью прячет свободную форму

### 🚀 Развёртывание

- **Shared-хостинг.** Заливаешь по FTP 4 файла + `assets/`; `api.php` сам стартует бэкенд. SSH на хост не нужен.
- **Только Python.** Бэкенд сам отдаёт фронтенд — ноль зависимостей.
- **Docker, systemd, reverse-proxy.** Рецепты в [`docs/deployment.md`](docs/deployment.md).
- Транспорт по обычному HTTP с автоматическим fallback на long-poll для хостов, которые буферизируют SSE.

## Сценарии

- **Корпоративный фаервол.** SSH-порт закрыт, открыт только HTTPS. websh туннелит через стандартный HTTPS.
- **Нет родного терминала.** Chromebook, iPad, kiosk. Любой браузер становится терминалом.
- **Доступ для клиента.** Даёшь клиенту ссылку на его собственный сервер. URL-якоря (`#connect=ServerName`) для прямых ссылок.
- **UI на bastion.** Ставишь websh на jump-host, ходишь во внутренние серверы из любого браузера.
- **Аварийный доступ с чужой машины.** Открыл URL — ты внутри.
- **Воркшопы.** Студентам не нужно ничего ставить локально.

## Быстрый старт (на своей машине)

```bash
git clone https://github.com/dolonet/websh.git
cd websh
python3 server.py
```

Открой http://localhost:8765 — всё. Без pip install, без npm, без сборки.

Нужны Python 3.5+ и `ssh` в PATH. По умолчанию сервер слушает
`127.0.0.1`; задай `HOST=0.0.0.0`, чтобы выставить его в локальную сеть.

## Быстрый старт (shared-хостинг)

**SSH-доступ не требуется.** Залей `index.html`, `websh.js`, `api.php`,
`server.py` и папку `assets/` в папку в веб-корне. Открой в браузере.
`api.php` сам запускает `server.py` при первом запросе.

`websh.json` (опционально, для серверных подключений) лежит **вне**
веб-корня — `api.php` по умолчанию ищет на два каталога выше себя.
Переопределяется через `WEBSH_CONFIG=/path/to/websh.json`.

Полная раскладка каталогов, решение проблем и нюансы пути конфига —
[`docs/deployment.md`](docs/deployment.md).

## Настройка

Большинству развёртываний нужно поменять только это:

```bash
PORT=8765           # порт для прослушивания
HOST=127.0.0.1      # адрес для bind (0.0.0.0 — в LAN)
WEBSH_CONFIG=...    # путь к websh.json (api.php автодетектит)
```

Полная таблица переменных окружения (rate-limits, лимиты сессий,
idle-TTL tmux, путь access-log…): [`docs/configuration.md`](docs/configuration.md).

## Развёртывание

- **Shared-хостинг (PHP + Python)** — FTP-drop 4 файлов + `assets/`. См. [`docs/deployment.md`](docs/deployment.md#shared-hosting-php--python).
- **Только Python** — `HOST=0.0.0.0 python3 server.py`. См. [`docs/deployment.md`](docs/deployment.md#python-only-no-php).
- **Docker** — `docker build -t websh . && docker run -d -p 8765:8765 -e HOST=0.0.0.0 websh`. См. [`docs/deployment.md`](docs/deployment.md#docker).
- **systemd** — unit `websh.service` в комплекте. См. [`docs/deployment.md`](docs/deployment.md#systemd).
- **HTTPS через reverse-proxy** — nginx / Caddy впереди для TLS. См. [`docs/deployment.md`](docs/deployment.md#https-via-reverse-proxy).

## Безопасность

**У websh намеренно нет встроенной аутентификации** — добавь её на
уровне веб-сервера (`auth_basic`, Cloudflare Access, Tailscale Funnel,
IP-allowlist'ы и т. д.). Threat-model, rate-limit'ы, формат JSON
access-log'а, интеграция с fail2ban, обработка host-keys и
ограничения сохранённых паролей — в [`docs/security.md`](docs/security.md).

## Документация

| Тема | Файл |
|---|---|
| Серверные профили подключений | [`docs/server-side-connections.md`](docs/server-side-connections.md) |
| Постоянные сессии (tmux) | [`docs/persistent-sessions.md`](docs/persistent-sessions.md) |
| Аутентификация и безопасность | [`docs/security.md`](docs/security.md) |
| Справочник по конфигурации | [`docs/configuration.md`](docs/configuration.md) |
| Рецепты развёртывания | [`docs/deployment.md`](docs/deployment.md) |
| Дизайн SSE-транспорта | [`docs/sse-transport.md`](docs/sse-transport.md) |
| Детекция auth-failure | [`docs/auth-fail-detection.md`](docs/auth-fail-detection.md) |

## Структура проекта

```
index.html                Фронтенд — xterm.js терминал + UI подключений
websh.js                  Логика фронтенда — управление панелями, передача файлов
api.php                   PHP-прокси — пробрасывает запросы браузера на бэкенд (опционально)
server.py                 Python-бэкенд — управляет SSH-сессиями через PTY, отдаёт фронтенд
assets/                   Бренд-SVG (логотип) загружаемый index.html
websh.json.example        Пример серверного конфига
test_server.py            Тесты бэкенда (unit + integration)
tests/frontend/           Тесты фронтенда на jsdom
docs/                     Заметки по архитектуре и справочная документация
Dockerfile                Развёртывание в контейнере
websh.service             unit-файл для systemd
LICENSE                   MIT-лицензия
```

## Тесты

```bash
# Бэкенд (Python, только stdlib — unittest)
python3 test_server.py -v

# Фронтенд (Node 20 + jsdom)
cd tests/frontend && npm install && npm test
```

Оба набора также прогоняются на каждом PR через GitHub Actions.

## Лицензия

MIT
