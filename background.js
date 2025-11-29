const BBS_ROOT = "https://bbs.uestc.edu.cn/";
const CHECK_URL = "https://bbs.uestc.edu.cn/home.php?mod=space";
const CHECK_INTERVAL_MINUTES = 1;

const URLS = {
  new: {
    home: "https://bbs.uestc.edu.cn/new",
    messages: "https://bbs.uestc.edu.cn/messages/posts",
  },
  old: {
    home: "https://bbs.uestc.edu.cn/forum.php",
    messages: "https://bbs.uestc.edu.cn/home.php?mod=space&do=notice",
  },
};

const STATE_DEFAULTS = {
  lastTotal: 0,
  notificationsEnabled: true,
  version: "new",
};

let cachedState = { ...STATE_DEFAULTS };
let stateReady = false;

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.notificationsEnabled && typeof changes.notificationsEnabled.newValue !== "undefined") {
    cachedState.notificationsEnabled = Boolean(changes.notificationsEnabled.newValue);
  }
  if (changes.version && typeof changes.version.newValue !== "undefined") {
    cachedState.version = changes.version.newValue;
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
    await ensureStateLoaded();
    const version = cachedState.version === "old" ? "old" : "new";
    const targetUrl = cachedState.lastTotal > 0 ? URLS[version].messages : URLS[version].home;
    await clearCountsAndBadge();
    await openOrFocusUrl(targetUrl);
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
    await persistState({ ...cachedState, lastTotal: total });

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
    await ensureStateLoaded();
    const version = cachedState.version === "old" ? "old" : "new";
    await clearCountsAndBadge();
    await openOrFocusUrl(URLS[version].messages);
  } finally {
    chrome.notifications.clear(notificationId);
  }
}

async function ensureStateLoaded() {
  if (stateReady) return;
  const storedState = await chrome.storage.local.get(STATE_DEFAULTS);
  cachedState = { ...STATE_DEFAULTS, ...storedState };
  stateReady = true;
}

async function persistState(nextState) {
  cachedState = nextState;
  await chrome.storage.local.set(nextState);
}

async function clearCountsAndBadge() {
  await ensureStateLoaded();
  await persistState({ ...cachedState, lastTotal: 0 });
  updateBadge("", "#000000");
}

async function maybeNotify(total, promptCount, pmCount) {
  if (total <= 0 || total === cachedState.lastTotal || !cachedState.notificationsEnabled) {
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
}

async function openOrFocusUrl(targetUrl) {
  const tabs = await chrome.tabs.query({ url: targetUrl });

  if (tabs.length > 0 && tabs[0].id) {
    const tab = tabs[0];
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: targetUrl });
  }
}
