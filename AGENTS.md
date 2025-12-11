# Repository Guidelines

## Project Structure & Module Organization
- Root contains the Chrome extension assets: `manifest.json` defines permissions and entrypoints; `background.js` is the service worker for alarms, fetching summaries, badge/notification updates, and MeoW 推送；`popup.html`/`popup.js` render the message list UI；`options.html`/`options.js` manage settings（版本切换、系统通知、MeoW 推送链接模式、昵称配置与测试）；`River.png` is the shared icon.
- No bundler or dependencies are present—HTML, JS, and CSS live together for each surface. Keep shared constants in `background.js`; reuse helper functions instead of duplicating logic in popup/options. Persist new settings alongside `STATE_DEFAULTS` and wire them through `chrome.storage`.

## Build, Test, and Development Commands
- No build step. Load the folder via Chrome `chrome://extensions` → Developer Mode → Load unpacked.
- After edits, click “Reload” in the extensions page; for background logs, open “service worker” devtools; for popup/UI debugging, open the popup then right-click → Inspect.
- Optional quick syntax check: run `node --check file.js` for whichever JS file you edited before reloading.

## Coding Style & Naming Conventions
- JavaScript uses 2-space indentation, semicolons, and `const`/`let` (avoid `var`). Prefer arrow functions for callbacks and small helpers.
- Keep user-facing strings in Simplified Chinese to match existing UI. Persist defaults in `STATE_DEFAULTS` and storage keys in one place.
- Fetch helpers already wrap API endpoints—extend them instead of sprinkling new fetch calls. Favor early returns for guards and small, pure utilities for parsing response payloads.

## Testing Guidelines
- Manual verification: ensure login state is detected, badge updates, and notifications open the correct URL targets. Test both “new” and “old” BBS versions via the options page toggle.
- When changing popup rendering, verify empty state, error state, and “mark as read” actions. Check notification click handlers still focus or open tabs as expected.
- There is no automated test suite; keep changes minimal and isolate UI/logic to simplify manual checks.

## Commit & Pull Request Guidelines
- Follow Conventional Commit style seen in history (`feat(scope): ...`, `style(scope): ...`); short English or Chinese descriptions are acceptable.
- Include PR notes on what changed, manual test steps (browsers/versions), and any screenshots for UI adjustments. Reference related issues or tasks when available.

## Permissions & Configuration Notes
- Host permissions target `bbs.uestc.edu.cn` (session via cookies) and `api.chuckfang.com` for MeoW 推送; avoid broadening scopes without strong justification.
- Keep alarms lightweight (current 1-minute interval) and avoid blocking the service worker. For new settings, surface toggles in `options.html` and persist via `chrome.storage`. MeoW push uses `api.chuckfang.com`; keep host permissions limited to the existing domains.
