const BBS_ROOT = "https://bbs.uestc.edu.cn/";
const HOME_URL = "https://bbs.uestc.edu.cn/new";
const CHECK_URL = "https://bbs.uestc.edu.cn/home.php?mod=space";
const CHECK_INTERVAL_MINUTES = 1;
const STATE_DEFAULTS = { lastTotal: 0, notificationsEnabled: true };
let cachedState = { ...STATE_DEFAULTS };
let stateReady = false;

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.notificationsEnabled && typeof changes.notificationsEnabled.newValue !== "undefined") {
    cachedState.notificationsEnabled = Boolean(changes.notificationsEnabled.newValue);
  }
});

chrome.runtime.onInstalled.addListener(() => { startup(); });
chrome.runtime.onStartup.addListener(() => { startup(); });

async function startup() {
  await ensureStateLoaded();
  chrome.alarms.clearAll(() => {
    chrome.alarms.create("mainLoop", { periodInMinutes: CHECK_INTERVAL_MINUTES });
    checkStatus(); 
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "mainLoop") checkStatus();
});

chrome.action.onClicked.addListener(async () => {
  try {
    await clearCountsAndBadge();
    await openOrFocusHomeTab();
  } catch (error) {
    console.error(error);
  }
});

chrome.notifications.onClicked.addListener((notificationId) => {
  handleNotificationClick(notificationId).catch(console.error);
});

async function checkStatus() {
  try {
    await ensureStateLoaded();
    const htmlRes = await fetch(CHECK_URL, {
        credentials: 'include',
        cache: 'no-store',
        headers: {
            'X-Uestc-Bbs': '1',
            'Referer': BBS_ROOT
        }
    });
    
    if (!htmlRes.ok) {
        updateBadge("?", "#999999");
        return;
    }

    const htmlText = await htmlRes.text();

    if (!htmlText.includes("action=logout")) {
        updateBadge("未登录", "#999999");
        return;
    }

    let promptCount = 0;
    let pmCount = 0;

    const promptMatch = htmlText.match(/id="myprompt"[^>]*>.*?\((\d+)\)/);
    if (promptMatch && promptMatch[1]) {
        promptCount = parseInt(promptMatch[1]);
    }

    const pmHasNew = /id="pm_ntc"[^>]*class="[^"]*\bnew\b"/.test(htmlText);
    if (pmHasNew) {
        pmCount = 1; 
    }

    const total = promptCount + pmCount;

    if (total > 0) {
        updateBadge(total.toString(), "#00FF00");
    } else {
        updateBadge("", "#000000"); 
    }

    await maybeNotify(total, promptCount, pmCount);

  } catch (error) {
    console.error(error);
    updateBadge("ERR", "#FF0000");
  }
}

function updateBadge(text, color) {
  chrome.action.setBadgeText({ text: text });
  chrome.action.setBadgeBackgroundColor({ color: color });
}

async function handleNotificationClick(notificationId) {
  try {
    await clearCountsAndBadge();
    await openOrFocusHomeTab();
  } finally {
    chrome.notifications.clear(notificationId);
  }
}

async function ensureStateLoaded() {
  if (stateReady) return;
  cachedState = await chrome.storage.local.get(STATE_DEFAULTS);
  stateReady = true;
}

async function persistState(nextState) {
  cachedState = nextState;
  stateReady = true;
  await chrome.storage.local.set(nextState);
}

async function clearCountsAndBadge() {
  await ensureStateLoaded();
  await persistState({ ...cachedState, lastTotal: 0 });
  updateBadge("", "#000000");
}

async function maybeNotify(total, promptCount, pmCount) {
  const currentState = cachedState;

  if (total <= 0) {
    if (currentState.lastTotal !== 0) await persistState({ ...currentState, lastTotal: 0 });
    return;
  }

  if (currentState.lastTotal === total) return;

  if (!currentState.notificationsEnabled) {
    await persistState({ ...currentState, lastTotal: total });
    return;
  }

  const parts = [];
  if (promptCount > 0) parts.push(`提醒 ${promptCount} 条`);
  if (pmCount > 0) parts.push("有新私信");
  const message = parts.join("，") || "收到新的站内消息";

  chrome.notifications.create(`riverside-${Date.now()}`, {
    type: "basic",
    iconUrl: "River.png",
    title: "清水河畔助手提醒",
    message,
    priority: 2,
    eventTime: Date.now()
  });

  await persistState({ ...currentState, lastTotal: total });
}

async function openOrFocusHomeTab() {
  const tabs = await chrome.tabs.query({ url: `${BBS_ROOT}*` });
  const homeTab = tabs.find((tab) => isHomeTabUrl(tab.url));

  if (homeTab && homeTab.id !== undefined) {
    await chrome.tabs.update(homeTab.id, { active: true });
    await chrome.windows.update(homeTab.windowId, { focused: true });
    return;
  }

  await chrome.tabs.create({ url: HOME_URL });
}

function isHomeTabUrl(url) {
  if (!url) return false;
  if (url === HOME_URL || url.startsWith(`${HOME_URL}/`)) return true;
  return url === BBS_ROOT || url.startsWith(`${BBS_ROOT}forum.php`);
}
