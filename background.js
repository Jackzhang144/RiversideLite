const BBS_ROOT = "https://bbs.uestc.edu.cn/";
const CHECK_URL = "https://bbs.uestc.edu.cn/home.php?mod=space";
const CHECK_INTERVAL_MINUTES = 1;
const API_BASE = "https://bbs.uestc.edu.cn/_";
const SUMMARY_URL = `${API_BASE}/messages/summary`;
const READ_URL = (id, kind) =>
  `${API_BASE}/messages/notifications/read/${id}${kind ? `?kind=${encodeURIComponent(kind)}` : ""}`;
const MEO_W_BASE = "https://api.chuckfang.com";
const THREAD_URL_NEW = (threadId) => `https://bbs.uestc.edu.cn/thread/${threadId}`;
const THREAD_URL_OLD = (threadId) =>
  `https://bbs.uestc.edu.cn/forum.php?mod=viewthread&tid=${threadId}`;
const CHAT_URL_OLD_BASE = "https://bbs.uestc.edu.cn/home.php?mod=space&do=pm";

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
  authorizationHeader: "",
  meowPushEnabled: false,
  meowNickname: "",
};

let cachedState = { ...STATE_DEFAULTS };
let stateReady = false;
let adoptPromise = null;

const log = (...args) => console.log("[RiversideLite]", ...args);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.notificationsEnabled && typeof changes.notificationsEnabled.newValue !== "undefined") {
    cachedState.notificationsEnabled = Boolean(changes.notificationsEnabled.newValue);
  }
  if (changes.version && typeof changes.version.newValue !== "undefined") {
    cachedState.version = changes.version.newValue;
  }
  if (changes.authorizationHeader && typeof changes.authorizationHeader.newValue !== "undefined") {
    cachedState.authorizationHeader = changes.authorizationHeader.newValue || "";
  }
  if (changes.meowPushEnabled && typeof changes.meowPushEnabled.newValue !== "undefined") {
    cachedState.meowPushEnabled = Boolean(changes.meowPushEnabled.newValue);
  }
  if (changes.meowNickname && typeof changes.meowNickname.newValue !== "undefined") {
    cachedState.meowNickname = changes.meowNickname.newValue || "";
  }
});

chrome.runtime.onInstalled.addListener(() => { startup(); });
chrome.runtime.onStartup.addListener(() => { startup(); });

async function startup() {
  await ensureStateLoaded();
  await ensureMeowDefaultPersisted();
  setActionPopup();
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
    await refreshAndShow();
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
    const previousTotal = cachedState.lastTotal;
    const summary = await fetchSummaryApi();
    const payload = summary?.data && summary.code !== undefined ? summary.data : summary;
    const chat = payload?.new_messages?.chat || 0;
    const postsObj = payload?.new_messages?.posts || {};
    const notice = Object.values(postsObj).reduce(
      (acc, val) => acc + (typeof val === "number" ? val : 0),
      0
    );
    const total = chat + notice;
    log("checkStatus summary counts", { total, notice, chat });

    if (total > 0) {
      updateBadge(total.toString(), "#00FF00");
    } else {
      updateBadge("", "#000000");
    }

    setActionPopup();
    await maybeNotify(total, notice, chat, previousTotal, payload);
    await persistState({ ...cachedState, lastTotal: total });

  } catch (error) {
    console.error(error);
    const statusCode = getErrorStatusCode(error);
    if (statusCode === 401) {
      updateBadge("未登录", "#999999");
      return;
    }
    if (statusCode) {
      updateBadge(String(statusCode), "#FF0000");
    } else {
      updateBadge("ERR", "#FF0000");
    }
  }
}

function setActionPopup() {
  chrome.action.setPopup({ popup: "popup.html" });
}

async function refreshAndShow() {
  // Force a fresh summary to update badge/counts before popup opens
  try {
    const summary = await fetchSummaryApi();
    // Optionally update stored total to keep badge in sync
    const payload = summary?.data && summary.code !== undefined ? summary.data : summary;
    const chat = payload?.new_messages?.chat || 0;
    const postsObj = payload?.new_messages?.posts || {};
    const notice = Object.values(postsObj).reduce(
      (acc, val) => acc + (typeof val === "number" ? val : 0),
      0
    );
    const total = chat + notice;
    await persistState({ ...cachedState, lastTotal: total });
    updateBadge(total > 0 ? total.toString() : "", total > 0 ? "#00FF00" : "#000000");
  } catch (error) {
    console.error("refreshAndShow failed", error);
  } finally {
    setActionPopup();
    // open popup by programmatically toggling
    chrome.action.openPopup?.();
  }
}

function updateBadge(text, color) {
  chrome.action.setBadgeText({ text: text });
  chrome.action.setBadgeBackgroundColor({ color: color });
}

function getErrorStatusCode(error) {
  if (!error) return null;
  if (typeof error.status === "number") return error.status;
  const match = (error?.message || "").match(/\b(\d{3})\b/);
  if (!match) return null;
  const code = Number(match[1]);
  return Number.isNaN(code) ? null : code;
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

async function ensureMeowDefaultPersisted() {
  const { meowPushEnabled } = await chrome.storage.local.get(["meowPushEnabled"]);
  if (typeof meowPushEnabled === "undefined") {
    await chrome.storage.local.set({ meowPushEnabled: false });
  }
}

async function persistState(nextState) {
  cachedState = nextState;
  await chrome.storage.local.set(nextState);
}

async function clearCountsAndBadge() {
  await ensureStateLoaded();
  await persistState({ ...cachedState, lastTotal: 0 });
  updateBadge("", "#000000");
  setActionPopup();
}

async function maybeNotify(total, promptCount, pmCount, previousTotal, payload) {
  if (total <= 0 || total === previousTotal) {
    return;
  }

  const shouldPushMeow = cachedState.meowPushEnabled && Boolean((cachedState.meowNickname || "").trim());
  const shouldShowNotification = cachedState.notificationsEnabled;

  if (!shouldPushMeow && !shouldShowNotification) {
    log("notify skipped: both system notification and MeoW disabled");
    return;
  }

  let message = buildNotifyFallback(promptCount, pmCount);
  const version = cachedState.version === "old" ? "old" : "new";
  let effectivePayload = payload;

  try {
    if (!effectivePayload) {
      const summary = await fetchSummaryApi();
      effectivePayload = summary?.data && summary.code !== undefined ? summary.data : summary;
    }
    const items = Array.isArray(effectivePayload?.new_notifications)
      ? effectivePayload.new_notifications
      : [];
    const chats = Array.isArray(effectivePayload?.new_chats) ? effectivePayload.new_chats : [];

    const lines = [];
    if (items.length) {
      lines.push(
        ...items.slice(0, 3).map((item) => buildNotificationText(item))
      );
    }
    if (chats.length) {
      lines.push(
        ...chats.slice(0, 2).map((chat) => {
          const title = normalizeText(chat.subject || chat.to_username || chat.last_author || "站内信");
          const body = stripHtml(chat.last_summary || "");
          return [title, body].filter(Boolean).join(" - ").slice(0, 140);
        })
      );
    } else if (payload?.new_messages?.chat) {
      lines.push(`站内信 ${payload.new_messages.chat} 条`);
    }
    if (lines.length) {
      message = lines.join("\n");
    }
  } catch (error) {
    console.error("notify summary failed", error);
  }

  const meowTarget = buildMeowTarget(effectivePayload, version);
  const meowPayloads = buildMeowPayloads(effectivePayload, version, message, meowTarget);

  if (shouldPushMeow) {
    for (const entry of meowPayloads) {
      await maybeSendMeowPush(entry.text, total, { targetUrl: entry.target });
    }
  }

  if (!shouldShowNotification) {
    return;
  }

  chrome.notifications.create(`riverside-${Date.now()}`, {
    type: "basic",
    iconUrl: "River.png",
    title: "清水河畔助手提醒",
    message,
    priority: 2,
    eventTime: Date.now()
  });
}

async function ensureBadge() {
  try {
    const summary = await fetchSummaryApi();
    const payload = summary?.data && summary.code !== undefined ? summary.data : summary;
    const chat = payload?.new_messages?.chat || 0;
    const postsObj = payload?.new_messages?.posts || {};
    const notice = Object.values(postsObj).reduce(
      (acc, val) => acc + (typeof val === "number" ? val : 0),
      0
    );
    const total = chat + notice;
    updateBadge(total > 0 ? total.toString() : "", total > 0 ? "#00FF00" : "#000000");
  } catch (_) {}
}

function buildNotifyFallback(promptCount, pmCount) {
  const parts = [];
  if (promptCount > 0) parts.push(`提醒 ${promptCount} 条`);
  if (pmCount > 0) parts.push("有新私信");
  return parts.join("，") || "收到新的站内消息";
}

async function maybeSendMeowPush(message, total, options = {}) {
  const { force = false, targetUrl } = options;
  if (!force && !cachedState.meowPushEnabled) {
    log("MeoW push skipped: disabled");
    return;
  }
  const nickname = (cachedState.meowNickname || "").trim();
  if (!nickname) {
    log("MeoW push skipped: empty nickname");
    return;
  }

  const content = message || "收到新的站内消息";
  const title = total > 0 ? `清水河畔 ${total} 条新提醒` : "清水河畔助手提醒";
  const version = cachedState.version === "old" ? "old" : "new";
  const finalTarget = targetUrl || URLS[version].messages;
  const endpoint = new URL(`${MEO_W_BASE}/${encodeURIComponent(nickname)}/${encodeURIComponent(title)}`);
  endpoint.searchParams.set("msgType", "text");
  const body = new URLSearchParams();
  body.set("title", title);
  body.set("msg", content);
  body.set("url", finalTarget);

  try {
    log("MeoW push request", {
      endpoint: endpoint.toString(),
      title,
      targetUrl: finalTarget,
      contentLength: content.length,
    });
    const res = await fetch(endpoint.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) {
      log("MeoW push failed", res.status);
    } else {
      log("MeoW push success", res.status);
    }
  } catch (error) {
    console.error("MeoW push error", error);
  }
}

function normalizeText(raw) {
  if (!raw) return "";
  return raw.replace(/&nbsp;?/gi, " ").replace(/\u00a0/g, " ").trim();
}

function stripHtml(raw) {
  if (!raw) return "";
  const text = raw.replace(/<[^>]+>/g, " ");
  return normalizeText(text);
}

function buildNotificationText(item) {
  if (!item) return "";
  const body = stripHtml(item.summary || item.html_message || "");
  const title = normalizeText(item.subject || item.summary || "提醒");
  return (body || title).slice(0, 140) || "收到新的提醒";
}

function buildMeowTarget(payload, version) {
  const fallback = version === "old" ? URLS.old.messages : URLS.new.messages;
  if (!payload) return fallback;
  const items = Array.isArray(payload?.new_notifications) ? payload.new_notifications : [];
  const chats = Array.isArray(payload?.new_chats) ? payload.new_chats : [];

  const firstNotification = items.find(
    (item) => !isRateNotification(item) && !isTaskCompletionNotification(item)
  );
  if (firstNotification) {
    const url = buildNotificationTarget(firstNotification, version, fallback);
    if (url) return url;
  }

  if (chats.length) {
    return buildLegacyChatUrl(chats[0]);
  }

  if (payload?.new_messages?.chat) {
    return buildLegacyChatUrl();
  }

  return fallback;
}

function buildNotificationTarget(item, version, fallback) {
  if (!item) return fallback;
  if (isRateNotification(item) || isTaskCompletionNotification(item)) return "";
  const summaryText = stripHtml([item?.summary, item?.html_message, item?.subject].filter(Boolean).join(" "));
  if (item.kind === "report" || /有新的举报等待处理/.test(summaryText)) {
    return "https://bbs.uestc.edu.cn/forum.php?mod=modcp&action=report";
  }
  if (item.thread_id) {
    return version === "old" ? THREAD_URL_OLD(item.thread_id) : THREAD_URL_NEW(item.thread_id);
  }
  return fallback;
}

function buildMeowPayloads(payload, version, fallbackText, fallbackTarget) {
  const fallback = fallbackTarget || (version === "old" ? URLS.old.messages : URLS.new.messages);
  const results = [];
  if (payload) {
    const items = Array.isArray(payload?.new_notifications) ? payload.new_notifications : [];
    const chats = Array.isArray(payload?.new_chats) ? payload.new_chats : [];

    items.forEach((item) => {
      const target = buildNotificationTarget(item, version, fallback);
      if (!target) return;
      const text = buildNotificationText(item);
      results.push({ text, target });
    });

    chats.forEach((chat) => {
      const target = buildLegacyChatUrl(chat);
      const title = normalizeText(chat.subject || chat.to_username || chat.last_author || "站内信");
      const body = stripHtml(chat.last_summary || "");
      const text = [title, body].filter(Boolean).join(" - ").slice(0, 140) || "收到新的站内信";
      results.push({ text, target });
    });
  }

  if (!results.length) {
    results.push({ text: fallbackText || "收到新的站内消息", target: fallback });
  }

  return results;
}

function isRateNotification(item) {
  if (item?.kind === "rate") return true;
  const text = stripHtml([item?.summary, item?.html_message, item?.subject].filter(Boolean).join(" "));
  return /帖子.*被.*评分/.test(text);
}

function isTaskCompletionNotification(item) {
  const text = stripHtml([item?.subject, item?.summary, item?.html_message].filter(Boolean).join(" "));
  return text.includes("恭喜您完成任务");
}

function buildLegacyChatUrl(chat) {
  if (chat?.to_uid) {
    return `${CHAT_URL_OLD_BASE}&subop=view&touid=${chat.to_uid}#last`;
  }
  if (chat?.conversation_id) {
    return `${CHAT_URL_OLD_BASE}&subop=view&plid=${chat.conversation_id}&type=1#last`;
  }
  return CHAT_URL_OLD_BASE;
}

async function sendMeowTest() {
  await ensureStateLoaded();
  const nickname = (cachedState.meowNickname || "").trim();
  if (!nickname) {
    throw new Error("请先填写 MeoW 昵称");
  }
  log("MeoW test push start");
  const content = "这是一条 MeoW 测试推送，来自清水河畔助手。";
  await maybeSendMeowPush(content, 1, { force: true });
  return true;
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

chrome.runtime.onMessage.addListener((message, _, sendResponse) => {
  if (message?.type === "clearBadge") {
    clearCountsAndBadge()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error(error);
        sendResponse({ ok: false });
      });
    return true;
  }
  if (message?.type === "fetchSummary") {
    fetchSummaryApi()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => {
        console.error(error);
        sendResponse({ ok: false, error: error?.message || "unknown", status: error?.status });
      });
    return true;
  }
  if (message?.type === "markRead" && typeof message.id === "number") {
    markNotificationRead(message.id, message.kind)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error(error);
        sendResponse({ ok: false, error: error?.message || "unknown" });
      });
    return true;
  }
  if (message?.type === "ensureBadge") {
    ensureBadge()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error(error);
        sendResponse({ ok: false, error: error?.message || "unknown" });
      });
    return true;
  }
  if (message?.type === "sendMeowTest") {
    sendMeowTest()
      .then((ok) => sendResponse({ ok }))
      .catch((error) => {
        console.error(error);
        sendResponse({ ok: false, error: error?.message || "unknown" });
      });
    return true;
  }
  return false;
});

async function fetchSummaryApi() {
  const res = await callApiWithAuth("GET", SUMMARY_URL);
  if (res.ok) return res.json();
  log("summary primary failed", res.status);
  if (res.status === 401) {
    const pageData = await fetchSummaryViaPage();
    if (pageData) return pageData;
  }
  const error = new Error(`summary status ${res.status}`);
  error.status = res.status;
  throw error;
}

async function markNotificationRead(id, kind) {
  const res = await callApiWithAuth("POST", READ_URL(id, kind));
  if (res.ok) return;
  log("mark read primary failed", res.status);
  if (res.status === 401) {
    const ok = await markReadViaPage(id, kind);
    if (ok) return;
  }
  throw new Error(`mark read status ${res.status}`);
}

async function callApiWithAuth(method, url) {
  await ensureStateLoaded();
  if (!cachedState.authorizationHeader) {
    const auth = await readAuthorizationFromPage();
    if (auth) {
      log("loaded auth from page");
      await persistState({ ...cachedState, authorizationHeader: auth });
    }
  }
  const headers = {
    "X-UESTC-BBS": "1",
    Referer: BBS_ROOT,
  };
  if (cachedState.authorizationHeader) {
    headers["Authorization"] = cachedState.authorizationHeader;
  }
  const doFetch = () =>
    fetch(url, {
      method,
      credentials: "include",
      cache: "no-store",
      headers,
    });

  let res = await doFetch();
  if (res.status === 401) {
    log("api 401, retrying with fresh auth");
    const freshAuth = await readAuthorizationFromPage();
    if (freshAuth && freshAuth !== cachedState.authorizationHeader) {
      await persistState({ ...cachedState, authorizationHeader: freshAuth });
      headers["Authorization"] = freshAuth;
      res = await doFetch();
    }
  }
  if (res.status === 401 && !cachedState.authorizationHeader) {
    const adopted = await ensureAuthorization();
    if (adopted) {
      headers["Authorization"] = cachedState.authorizationHeader;
      res = await doFetch();
    }
  }
  return res;
}

async function ensureAuthorization() {
  if (adoptPromise) return adoptPromise;
  adoptPromise = adoptLegacyAuth()
    .catch(() => false)
    .finally(() => {
      adoptPromise = null;
    });
  return adoptPromise;
}

async function adoptLegacyAuth() {
  try {
    const headers = {
      "X-UESTC-BBS": "1",
      Referer: BBS_ROOT,
    };

    const res = await fetch(`${API_BASE}/auth/adoptLegacyAuth`, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers,
    });
    if (!res.ok) return false;
    const data = await res.json();
    const auth = data?.data?.authorization || data?.authorization;
    if (auth) {
      log("adoptLegacyAuth succeeded");
      await persistState({ ...cachedState, authorizationHeader: auth });
      return true;
    }
  } catch (error) {
    console.error("adoptLegacyAuth failed", error);
  }
  return false;
}

async function readAuthorizationFromPage() {
  const tab = await getAnyBbsTab();
  if (!tab) {
    log("no bbs tab found for reading auth");
    return "";
  }
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      try {
        return localStorage.getItem("newbbs_authorization") || "";
      } catch {
        return "";
      }
    },
  });
  const value = (result && typeof result.result === "string" && result.result) || "";
  log("read auth from page length", value.length);
  return value;
}

async function fetchSummaryViaPage() {
  const tab = await getAnyBbsTab();
  if (!tab) {
    log("page fetch skipped: no bbs tab");
    return null;
  }
  log("page fetch summary via tab", tab.id);
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async () => {
      try {
        const res = await fetch("/_/messages/summary", {
          method: "GET",
          credentials: "include",
          cache: "no-store",
          headers: { "X-UESTC-BBS": "1" },
        });
        if (!res.ok) return { ok: false, status: res.status };
        const data = await res.json();
        return { ok: true, data };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    },
  });
  if (result?.result?.ok) {
    log("page fetch summary ok");
    return result.result.data;
  }
  if (result?.result?.status === 401) {
    log("page fetch summary 401");
    return null;
  }
  const errMsg = result?.result?.error || `page summary status ${result?.result?.status}`;
  log("page fetch summary failed", errMsg);
  throw new Error(errMsg);
}

async function markReadViaPage(id, kind) {
  const tab = await getAnyBbsTab();
  if (!tab) {
    log("page markRead skipped: no bbs tab");
    return false;
  }
  log("page markRead via tab", tab.id);
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [id, kind],
    func: async (nid, nkind) => {
      try {
        const res = await fetch(
          `/_/messages/notifications/read/${nid}${nkind ? `?kind=${encodeURIComponent(nkind)}` : ""}`,
          {
            method: "POST",
            credentials: "include",
            cache: "no-store",
            headers: { "X-UESTC-BBS": "1" },
          }
        );
        return res.ok;
      } catch {
        return false;
      }
    },
  });
  const ok = Boolean(result?.result);
  log("page markRead result", ok);
  return ok;
}

async function getAnyBbsTab() {
  const tabs = await chrome.tabs.query({
    url: ["*://bbs.uestc.edu.cn/*"],
  });
  return tabs[0];
}
