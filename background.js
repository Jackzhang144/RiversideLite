importScripts("shared.js");

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
const THREAD_REDIRECT_OLD = (threadId, postId) =>
  `https://bbs.uestc.edu.cn/forum.php?mod=redirect&goto=findpost&ptid=${threadId}&pid=${postId}`;
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
  ...STORAGE_DEFAULTS,
  lastTotal: 0,
  lastErrorCode: "",
  authorizationHeader: "",
};

let cachedState = { ...STATE_DEFAULTS };
let stateReady = false;
let adoptPromise = null;

const log = (...args) => {
  const ts = new Date().toISOString();
  console.log(`[RiversideLite][${ts}]`, ...args);
};

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
  if (changes.meowLinkMode && typeof changes.meowLinkMode.newValue !== "undefined") {
    cachedState.meowLinkMode = changes.meowLinkMode.newValue || "none";
  }
  if (changes.lastErrorCode && typeof changes.lastErrorCode.newValue !== "undefined") {
    cachedState.lastErrorCode = changes.lastErrorCode.newValue || "";
  }
  if (changes.accounts && Array.isArray(changes.accounts.newValue)) {
    cachedState.accounts = changes.accounts.newValue;
  }
  if (changes.activeUsername && typeof changes.activeUsername.newValue !== "undefined") {
    cachedState.activeUsername = changes.activeUsername.newValue || "";
  }
});

chrome.runtime.onInstalled.addListener(() => { startup(); });
chrome.runtime.onStartup.addListener(() => { startup(); });

async function startup() {
  await ensureStateLoaded();
  await ensureDefaultsPersisted();
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
    const { chat, notice, total } = getSummaryCounts(payload);
    log("checkStatus summary counts", { total, notice, chat });

    if (total > 0) {
      updateBadge(total.toString(), "#00FF00");
    } else {
      updateBadge("", "#000000");
    }

    setActionPopup();
    await maybeNotify(total, notice, chat, previousTotal, payload);
    await persistState({ ...cachedState, lastTotal: total, lastErrorCode: "" });

  } catch (error) {
    console.error(error);
    const statusCode = getErrorStatusCode(error);
    if (statusCode === 401) {
      updateBadge("未登录", "#999999");
    } else if (statusCode) {
      updateBadge(String(statusCode), "#FF0000");
    } else {
      updateBadge("ERR", "#FF0000");
    }
    await maybeNotifyError(statusCode, error);
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
    const { total } = getSummaryCounts(payload);
    await persistState({ ...cachedState, lastTotal: total, lastErrorCode: "" });
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

function getSummaryCounts(payload) {
  const chat = toCount(payload?.new_messages?.chat) || 0;
  const postsObj = payload?.new_messages?.posts || {};
  let notice = sumNumericValues(postsObj);
  const reportFromPosts = toCount(postsObj?.report);
  if (reportFromPosts === null) {
    const reportFromMessages = toCount(payload?.new_messages?.report);
    if (reportFromMessages !== null) {
      notice += reportFromMessages;
    } else {
      notice += countReportNotifications(payload);
    }
  }
  const notificationsCount = Array.isArray(payload?.new_notifications) ? payload.new_notifications.length : 0;
  if (notificationsCount > notice) {
    notice = notificationsCount;
  }
  return { chat, notice, total: chat + notice };
}

function sumNumericValues(obj) {
  if (!obj || typeof obj !== "object") return 0;
  return Object.values(obj).reduce((acc, val) => {
    const num = toCount(val);
    return Number.isFinite(num) ? acc + num : acc;
  }, 0);
}

function toCount(value) {
  if (value === null || typeof value === "undefined") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function countReportNotifications(payload) {
  const items = Array.isArray(payload?.new_notifications) ? payload.new_notifications : [];
  return items.filter((item) => isReportNotification(item)).length;
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

async function ensureDefaultsPersisted() {
  const { meowPushEnabled, meowLinkMode, lastErrorCode, accounts, activeUsername } =
    await chrome.storage.local.get([
      "meowPushEnabled",
      "meowLinkMode",
      "lastErrorCode",
      "accounts",
      "activeUsername",
    ]);
  const updates = {};
  if (typeof meowPushEnabled === "undefined") {
    updates.meowPushEnabled = STATE_DEFAULTS.meowPushEnabled;
  }
  if (typeof meowLinkMode === "undefined") {
    updates.meowLinkMode = STATE_DEFAULTS.meowLinkMode;
  }
  if (typeof lastErrorCode === "undefined") {
    updates.lastErrorCode = STATE_DEFAULTS.lastErrorCode;
  }
  if (!Array.isArray(accounts)) {
    updates.accounts = STATE_DEFAULTS.accounts;
  }
  if (typeof activeUsername === "undefined") {
    updates.activeUsername = STATE_DEFAULTS.activeUsername;
  }
  if (Object.keys(updates).length) {
    await chrome.storage.local.set(updates);
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
  const linkMode = cachedState.meowLinkMode || "thread";
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

  const meowTarget = buildMeowTarget(effectivePayload, version, linkMode);
  const meowPayloads = buildMeowPayloads(effectivePayload, version, message, meowTarget, linkMode);

  if (shouldPushMeow) {
    for (const entry of meowPayloads) {
      await maybeSendMeowPush(entry.text, total, {
        targetUrl: entry.target,
        includeUrl: linkMode !== "none",
      });
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

async function maybeNotifyError(statusCode, error) {
  await ensureStateLoaded();
  const codeKey = statusCode ? String(statusCode) : "ERR";
  if (cachedState.lastErrorCode === codeKey) return;

  const shouldPushMeow = cachedState.meowPushEnabled && Boolean((cachedState.meowNickname || "").trim());
  const shouldShowNotification = cachedState.notificationsEnabled;
  const version = cachedState.version === "old" ? "old" : "new";
  const linkMode = cachedState.meowLinkMode || "thread";
  const target = buildErrorTarget(linkMode, version);

  const baseText = statusCode ? `请求失败（${statusCode}）` : "请求失败";
  const detail = error?.message ? `原因：${error.message}` : "请检查登录状态或网络。";
  const message = `${baseText}，${detail}`;

  await persistState({ ...cachedState, lastErrorCode: codeKey });

  if (shouldShowNotification) {
    chrome.notifications.create(`riverside-err-${Date.now()}`, {
      type: "basic",
      iconUrl: "River.png",
      title: "清水河畔助手异常",
      message,
      priority: 2,
    });
  }

  if (shouldPushMeow) {
    await maybeSendMeowPush(message, 0, {
      targetUrl: target,
      includeUrl: linkMode !== "none",
    });
  }
}

async function ensureBadge() {
  try {
    const summary = await fetchSummaryApi();
    const payload = summary?.data && summary.code !== undefined ? summary.data : summary;
    const { total } = getSummaryCounts(payload);
    updateBadge(total > 0 ? total.toString() : "", total > 0 ? "#00FF00" : "#000000");
  } catch (_) {}
}

async function switchAccountLegacy(username, password, captcha) {
  await ensureStateLoaded();
  const targetUser = (username || cachedState.activeUsername || "").trim();
  let pwd = password || "";
  log("switchAccountLegacy start", {
    targetUser,
    hasPassword: Boolean(password),
    hasCaptcha: Boolean(captcha?.code),
    hasCachedAuth: Boolean(cachedState.authorizationHeader),
  });
  if (!pwd && targetUser) {
    const accounts = await loadAccounts();
    const found = accounts.find((item) => item.username === targetUser);
    if (found?.passwordEnc) {
      try {
        pwd = await decryptPassword(found.passwordEnc);
      } catch (error) {
        console.error("decrypt password failed", error);
      }
    } else if (found?.password) {
      pwd = found.password;
    }
  }
  if (!targetUser) {
    throw new Error("请填写用户名和密码，或先在选项页保存账号。");
  }
  if (!pwd) {
    const currentUser = await fetchCurrentUsername();
    if (currentUser && currentUser === targetUser) {
      log("switchAccountLegacy reuse current session", { targetUser });
      await persistState({
        ...cachedState,
        lastTotal: 0,
        lastErrorCode: "",
        activeUsername: targetUser,
      });
      await checkStatus();
      return true;
    }
    throw new Error("请填写用户名和密码，或先在选项页保存账号。");
  }

  const sameUser = targetUser === cachedState.activeUsername;
  if (sameUser && cachedState.authorizationHeader) {
    log("switchAccountLegacy same user, reuse auth", { targetUser });
    await checkStatus();
    return true;
  }
  if (sameUser && !cachedState.authorizationHeader) {
    log("switchAccountLegacy same user, adopting auth", { targetUser });
    const adopted = await ensureAuthorization();
    if (adopted) {
      await persistState({
        ...cachedState,
        lastTotal: 0,
        lastErrorCode: "",
      });
      await checkStatus();
      return true;
    }
  }

  let loginSucceeded = false;
  try {
    log("switchAccountLegacy login", { targetUser, hasPwd: Boolean(pwd) });
    const loginOk = await loginLegacy(targetUser, pwd, captcha);
    loginSucceeded = Boolean(loginOk);
    if (!loginOk) {
      throw new Error("登录失败，请检查用户名或密码");
    }
    log("switchAccountLegacy login ok, adopting auth");
    const adopted = await adoptLegacyAuth();
    if (!adopted) {
      throw new Error("登录成功但获取凭证失败，请在站点打开页面后重试");
    }
    await persistState({
      ...cachedState,
      lastTotal: 0,
      lastErrorCode: "",
      activeUsername: targetUser,
    });
    await reloadBbsTabs();
    await checkStatus();
    return true;
  } catch (error) {
    console.error("switchAccountLegacy failed", summarizeLoginError(error));
    if (loginSucceeded) {
      await persistState({
        ...cachedState,
        authorizationHeader: "",
        lastTotal: 0,
        lastErrorCode: "",
        activeUsername: targetUser,
      });
      await reloadBbsTabs();
    }
    throw error;
  }
}

async function fetchCurrentUsername() {
  try {
    const url = `${API_BASE}/user/me/profile?user_summary=1`;
    const res = await callApiWithAuth("GET", url);
    if (!res.ok) return "";
    const data = await res.json();
    return (
      data?.data?.user_summary?.username ||
      data?.user?.username ||
      ""
    );
  } catch (error) {
    console.warn("fetchCurrentUsername failed", error);
    return "";
  }
}

function buildNotifyFallback(promptCount, pmCount) {
  const parts = [];
  if (promptCount > 0) parts.push(`提醒 ${promptCount} 条`);
  if (pmCount > 0) parts.push("有新私信");
  return parts.join("，") || "收到新的站内消息";
}

async function maybeSendMeowPush(message, total, options = {}) {
  const { force = false, targetUrl, includeUrl = true } = options;
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
  const finalTarget = includeUrl ? targetUrl || URLS[version].messages : targetUrl || "";
  const endpoint = new URL(`${MEO_W_BASE}/${encodeURIComponent(nickname)}/${encodeURIComponent(title)}`);
  endpoint.searchParams.set("msgType", "text");
  const body = new URLSearchParams();
  body.set("title", title);
  body.set("msg", content);
  if (includeUrl && finalTarget) {
    body.set("url", finalTarget);
  }

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
  const decoded = decodeEntities(raw);
  return decoded.replace(/&nbsp;?/gi, " ").replace(/\u00a0/g, " ").trim();
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

function buildMeowTarget(payload, version, linkMode = "thread") {
  if (linkMode === "none") return "";
  const fallback = linkMode === "list"
    ? version === "old" ? URLS.old.messages : URLS.new.messages
    : version === "old"
    ? URLS.old.messages
    : URLS.new.messages;
  if (!payload) return fallback;
  const items = Array.isArray(payload?.new_notifications) ? payload.new_notifications : [];
  const chats = Array.isArray(payload?.new_chats) ? payload.new_chats : [];

  const firstNotification = items.find(
    (item) => !isRateNotification(item) && !isTaskCompletionNotification(item)
  );
  if (firstNotification) {
    const url = buildNotificationTarget(firstNotification, version, fallback, linkMode);
    if (url) return url;
  }

  if (chats.length) {
    return linkMode === "list" ? fallback : buildLegacyChatUrl(chats[0]);
  }

  if (payload?.new_messages?.chat) {
    return linkMode === "list" ? fallback : buildLegacyChatUrl();
  }

  return fallback;
}

function buildNotificationTarget(item, version, fallback, linkMode = "thread") {
  if (!item) return fallback;
  if (linkMode === "none") return "";
  if (linkMode === "list") return fallback;
  if (isRateNotification(item) || isTaskCompletionNotification(item)) return "";
  if (isReportNotification(item)) {
    return "https://bbs.uestc.edu.cn/forum.php?mod=modcp&action=report";
  }
  const url = buildThreadUrl(item, version === "old");
  return url || fallback;
}

function buildMeowPayloads(payload, version, fallbackText, fallbackTarget, linkMode = "thread") {
  const fallback = fallbackTarget || (version === "old" ? URLS.old.messages : URLS.new.messages);
  const results = [];
  if (payload) {
    const items = Array.isArray(payload?.new_notifications) ? payload.new_notifications : [];
    const chats = Array.isArray(payload?.new_chats) ? payload.new_chats : [];

    items.forEach((item) => {
      const target = linkMode === "none" ? "" : buildNotificationTarget(item, version, fallback, linkMode);
      if (!target && linkMode !== "none") return;
      const text = buildNotificationText(item);
      results.push({ text, target });
    });

    chats.forEach((chat) => {
      const target =
        linkMode === "thread"
          ? buildLegacyChatUrl(chat)
          : linkMode === "list"
          ? fallback
          : "";
      const title = normalizeText(chat.subject || chat.to_username || chat.last_author || "站内信");
      const body = stripHtml(chat.last_summary || "");
      const text = [title, body].filter(Boolean).join(" - ").slice(0, 140) || "收到新的站内信";
      results.push({ text, target });
    });
  }

  if (!results.length) {
    const target = linkMode === "none" ? "" : fallback;
    results.push({ text: fallbackText || "收到新的站内消息", target });
  }

  return results;
}

function buildErrorTarget(linkMode, version) {
  if (linkMode === "none") return "";
  if (linkMode === "list") {
    return version === "old" ? URLS.old.messages : URLS.new.messages;
  }
  return version === "old" ? URLS.old.messages : URLS.new.messages;
}

async function logoutLegacy() {
  try {
    const formhash = await fetchFormhash();
    if (!formhash) return false;
    const base = BBS_ROOT.replace(/\/$/, "");
    const url = `${base}/member.php?mod=logging&action=logout&formhash=${encodeURIComponent(formhash)}&inajax=1`;
    const res = await fetch(url, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: { Referer: BBS_ROOT },
    });
    return res.ok;
  } catch (error) {
    console.error("logoutLegacy failed", error);
    return false;
  }
}

async function loginLegacy(username, password, captchaInput = null) {
  const base = BBS_ROOT.replace(/\/$/, "");
  const url = new URL(`${base}/member.php`);
  url.searchParams.set("mod", "logging");
  url.searchParams.set("action", "login");
  url.searchParams.set("loginsubmit", "yes");
  if (captchaInput?.loginhash) {
    url.searchParams.set("loginhash", captchaInput.loginhash);
  }
  url.searchParams.set("inajax", "1");
  const body = new URLSearchParams();
  if (captchaInput?.auth) {
    body.set("auth", captchaInput.auth);
  }
  body.set("loginfield", "username");
  body.set("username", username);
  body.set("password", password);
  body.set("questionid", "0");
  body.set("cookietime", "2592000");
  if (captchaInput?.hash && captchaInput?.code) {
    body.set("seccodehash", captchaInput.hash);
    body.set("seccodeverify", captchaInput.code);
    body.set("seccodemodid", captchaInput.modid || "member::logging");
  }

  const res = await fetch(url.toString(), {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: BBS_ROOT,
      "X-Requested-With": "XMLHttpRequest",
    },
    body: body.toString(),
  });

  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`登录失败（${res.status}）`);
    err.status = res.status;
    throw err;
  }

  const result = parseLegacyLoginResponse(text);
  if (result.ok) return true;
  if (result.needCaptcha) {
    const auth = result.auth || captchaInput?.auth || "";
    const captcha = await fetchLoginCaptchaInfo({
      auth,
      hash: captchaInput?.hash || "",
      loginhash: captchaInput?.loginhash || "",
      modid: captchaInput?.modid || "member::logging",
    });
    log("loginLegacy requires captcha", {
      hasCaptcha: Boolean(captcha),
      hasAuth: Boolean(auth),
      captchaInvalid: Boolean(result.captchaInvalid),
    });
    const err = new Error(result.message || "需要验证码，请输入后重试");
    err.needCaptcha = true;
    err.captcha = captcha;
    throw err;
  }
  if (result.message) {
    throw new Error(result.message);
  }
  throw new Error("登录失败，请检查用户名或密码");
}

async function fetchLoginCaptchaInfo(options = {}) {
  try {
    const context = {
      auth: options.auth || "",
      hash: options.hash || "",
      loginhash: options.loginhash || "",
      modid: options.modid || "member::logging",
    };
    if (!context.hash || !context.loginhash) {
      const html = await fetchLoginPageHtml(context.auth);
      if (!html) return null;
      const parsed = parseLoginCaptchaPage(html);
      if (parsed?.hash && !context.hash) context.hash = parsed.hash;
      if (parsed?.loginhash && !context.loginhash) context.loginhash = parsed.loginhash;
      if (parsed?.modid) context.modid = parsed.modid;
      if (parsed?.auth && !context.auth) context.auth = parsed.auth;
    }
    if (!context.hash) {
      console.warn("captcha hash missing");
      return null;
    }
    const url = await fetchCaptchaImageUrl(context.hash, context.modid);
    const image = url ? await fetchCaptchaImageData(url) : "";
    return {
      hash: context.hash,
      url,
      image,
      loginhash: context.loginhash || "",
      modid: context.modid || "member::logging",
      auth: context.auth || "",
    };
  } catch (error) {
    console.error("fetchLoginCaptchaInfo failed", error);
    return null;
  }
}

function parseLegacyLoginResponse(text) {
  const decoded = decodeEntities(text || "");
  if (decoded.includes("欢迎您回来") || decoded.includes("succeedhandle_login")) {
    return { ok: true };
  }
  const message = extractLegacyLoginError(decoded);
  const loginPerm = extractLegacyLoginPerm(decoded);
  const auth = extractLegacyAuth(decoded);
  const captchaInvalid = /验证码.*错误/.test(message || "");
  const needCaptcha =
    captchaInvalid || /seccode|验证码|security|login_seccheck/i.test(decoded) || /验证码/.test(message || "");
  let finalMessage = message || "";
  if (!finalMessage && Number.isFinite(loginPerm)) {
    finalMessage = `登录失败，您还可以尝试 ${loginPerm} 次`;
  }
  if (!finalMessage && captchaInvalid) {
    finalMessage = "验证码填写错误，请重试";
  }
  return {
    ok: false,
    message: finalMessage,
    needCaptcha,
    auth,
    loginPerm,
    captchaInvalid,
  };
}

function extractLegacyLoginError(text) {
  if (!text) return "";
  const errorMatch = text.match(/errorhandle_\((?:'|")([^'"]+)(?:'|")/i);
  if (errorMatch && errorMatch[1]) {
    return decodeEntities(errorMatch[1]);
  }
  const cdataMatch = text.match(/<!\[CDATA\[(.*?)(?:<script|\]\]>)/is);
  if (cdataMatch && cdataMatch[1]) {
    const raw = cdataMatch[1].replace(/<[^>]+>/g, " ").trim();
    return decodeEntities(raw);
  }
  return "";
}

function extractLegacyLoginPerm(text) {
  if (!text) return null;
  const match = text.match(/loginperm['"]?\s*[:=]\s*['"]?(\d+)/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isNaN(value) ? null : value;
}

function extractLegacyAuth(text) {
  if (!text) return "";
  const match = text.match(/auth=([^&'"]+)/i);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

async function fetchLoginPageHtml(auth = "") {
  const base = BBS_ROOT.replace(/\/$/, "");
  const url = new URL(`${base}/member.php`);
  url.searchParams.set("mod", "logging");
  url.searchParams.set("action", "login");
  if (auth) {
    url.searchParams.set("auth", auth);
    url.searchParams.set("referer", BBS_ROOT);
  }
  url.searchParams.set("inajax", "1");
  const res = await fetch(url.toString(), {
    credentials: "include",
    cache: "no-store",
    headers: { Referer: BBS_ROOT },
  });
  if (!res.ok) return "";
  const text = await res.text();
  return extractLoginPageHtml(text);
}

function extractLoginPageHtml(text) {
  if (!text) return "";
  const cdataMatch = text.match(/<!\[CDATA\[(.*)\]\]>/is);
  if (cdataMatch && cdataMatch[1]) {
    return cdataMatch[1];
  }
  return text;
}

function parseLoginCaptchaPage(html) {
  if (!html) return null;
  const hashFromInput = html.match(/name=["']seccodehash["'][^>]*value=["']([^"']+)/i);
  const hashFromUpdate = html.match(/updateseccode\(['"]([^'"]+)['"]/i);
  const hashFromId = html.match(/seccode_(\w+)/i);
  const loginhashMatch = html.match(/loginhash=([A-Za-z0-9]+)/i);
  const modidMatch = html.match(/name=["']seccodemodid["'][^>]*value=["']([^"']+)/i);
  const authMatch = html.match(/name=["']auth["'][^>]*value=["']([^"']+)/i);
  const hash = (hashFromInput && hashFromInput[1]) || (hashFromUpdate && hashFromUpdate[1]) || (hashFromId && hashFromId[1]) || "";
  const loginhash = (loginhashMatch && loginhashMatch[1]) || "";
  const modid = (modidMatch && modidMatch[1]) || "member::logging";
  let auth = (authMatch && authMatch[1]) || "";
  if (auth) {
    try {
      auth = decodeURIComponent(auth);
    } catch {}
  }
  if (!hash && !loginhash) return null;
  return { hash, loginhash, modid, auth };
}

async function fetchCaptchaImageUrl(hash, modid = "member::logging") {
  if (!hash) return "";
  const base = BBS_ROOT.replace(/\/$/, "");
  const url = new URL(`${base}/misc.php`);
  url.searchParams.set("mod", "seccode");
  url.searchParams.set("action", "update");
  url.searchParams.set("idhash", hash);
  url.searchParams.set("modid", modid);
  url.searchParams.set("_", Math.random().toString().slice(2));
  const res = await fetch(url.toString(), {
    credentials: "include",
    cache: "no-store",
    headers: { Referer: BBS_ROOT },
  });
  if (!res.ok) return "";
  const text = await res.text();
  const match = text.match(/misc\.php\?mod=seccode&update=\d+&idhash=[A-Za-z0-9]+/i);
  if (!match) return "";
  const candidate = match[0];
  if (/^https?:/i.test(candidate)) return candidate;
  return new URL(candidate, base).toString();
}

async function fetchCaptchaImageData(url) {
  if (!url) return "";
  try {
    const res = await fetch(url, {
      credentials: "include",
      cache: "no-store",
      headers: { Referer: BBS_ROOT },
    });
    if (!res.ok) return "";
    const blob = await res.blob();
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);
    return `data:${blob.type || "image/png"};base64,${base64}`;
  } catch (error) {
    console.error("fetchCaptchaImageData failed", error);
    return "";
  }
}

function summarizeLoginError(error) {
  if (!error) return { message: "unknown" };
  return {
    message: error?.message || "unknown",
    status: error?.status,
    needCaptcha: Boolean(error?.needCaptcha),
    hasCaptcha: Boolean(error?.captcha?.hash || error?.captcha?.url || error?.captcha?.image),
  };
}

async function fetchFormhash() {
  try {
    const res = await fetch(BBS_ROOT, { credentials: "include", cache: "no-store" });
    if (!res.ok) return "";
    const html = await res.text();
    const match = html.match(/name=["']formhash["'] value=["']([^"']+)/i);
    return match ? match[1] : "";
  } catch (error) {
    console.error("fetchFormhash failed", error);
    return "";
  }
}

async function loadAccounts() {
  if (Array.isArray(cachedState.accounts) && cachedState.accounts.length) {
    return cachedState.accounts;
  }
  const stored = await chrome.storage.local.get(["accounts"]);
  if (Array.isArray(stored.accounts)) {
    return stored.accounts;
  }
  return [];
}

async function reloadBbsTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: ["*://bbs.uestc.edu.cn/*"] });
    for (const tab of tabs) {
      if (tab.id) {
        await chrome.tabs.reload(tab.id, { bypassCache: true });
      }
    }
  } catch (error) {
    console.error("reloadBbsTabs failed", error);
  }
}

function buildThreadUrl(item, useOld) {
  const { threadId, postId, page } = extractThreadLocation(item);
  if (!threadId && !postId) return useOld ? URLS.old.messages : URLS.new.messages;
  if (!threadId && postId && !useOld) {
    return buildGotoUrl(null, postId);
  }
  if (useOld) {
    if (postId) return THREAD_REDIRECT_OLD(threadId, postId);
    return THREAD_URL_OLD(threadId);
  }
  if (postId && !page) {
    // 当缺少页码时使用 /goto 路由以定位具体楼层
    return buildGotoUrl(threadId, postId);
  }
  const url = new URL(THREAD_URL_NEW(threadId));
  if (page) url.searchParams.set("page", page);
  if (postId) url.hash = `post-${postId}`;
  return url.toString();
}

function buildGotoUrl(threadId, postId) {
  const base = BBS_ROOT.replace(/\/$/, "");
  if (!postId) return threadId ? `${base}/thread/${threadId}` : base;
  if (threadId) return `${base}/goto/${threadId}/${postId}`;
  return `${base}/goto/${postId}`;
}

function extractThreadLocation(item) {
  const threadId = toPositiveInt(
    item?.thread_id || item?.tid || item?.threadId || item?.threadid || item?.topic_id
  );
  const postId = extractPostId(item);
  const page = extractPageNumber(item);
  const fromUrl = parseThreadUrl(
    item?.url ||
      item?.link ||
      item?.href ||
      item?.target_url ||
      item?.targetUrl ||
      item?.notification_url ||
      item?.notificationUrl
  );

  return {
    threadId: threadId || fromUrl.threadId,
    postId: postId || fromUrl.postId,
    page: page || fromUrl.page,
  };
}

function parseThreadUrl(raw) {
  if (!raw) return { threadId: null, postId: null, page: null };
  try {
    const url = new URL(raw, "https://bbs.uestc.edu.cn");
    let threadId = null;
    let postId = null;
    let page = null;

    const threadMatch = url.pathname.match(/\/thread\/(\d+)/);
    if (threadMatch) {
      threadId = toPositiveInt(threadMatch[1]);
    }
    if (url.pathname.includes("forum.php")) {
      threadId = threadId || toPositiveInt(url.searchParams.get("tid") || url.searchParams.get("ptid"));
    }
    page = toPositiveInt(url.searchParams.get("page")) || null;
    postId = toPositiveInt(url.searchParams.get("pid")) || postId;

    if (url.hash) {
      const hash = url.hash.replace(/^#/, "");
      if (hash.startsWith("post-")) {
        postId = toPositiveInt(hash.replace("post-", "")) || postId;
      } else {
        const pidMatch = hash.match(/pid(\d+)/);
        if (pidMatch) {
          postId = toPositiveInt(pidMatch[1]) || postId;
        }
      }
    }

    return { threadId, postId, page };
  } catch (error) {
    console.error("parseThreadUrl failed", error);
    return { threadId: null, postId: null, page: null };
  }
}

function extractPostId(item) {
  const candidates = [
    item?.post_id,
    item?.pid,
    item?.postId,
    item?.postid,
    item?.post?.id,
    item?.post?.pid,
  ];
  for (const candidate of candidates) {
    const num = toPositiveInt(candidate);
    if (num) return num;
  }
  return null;
}

function extractPageNumber(item) {
  const candidates = [
    item?.post_page,
    item?.page,
    item?.page_no,
    item?.page_num,
    item?.pageNumber,
    item?.page_index,
    item?.post?.page,
  ];
  for (const candidate of candidates) {
    const num = toPositiveInt(candidate);
    if (num) return num;
  }
  return null;
}

function toPositiveInt(value) {
  const num = Number(value);
  return Number.isInteger(num) && num > 0 ? num : null;
}

function decodeEntities(text) {
  if (!text) return "";
  const map = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: "\"",
    apos: "'",
    nbsp: " ",
  };
  return text.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (_, entity) => {
    if (entity in map) return map[entity];
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : "";
    }
    if (entity.startsWith("#")) {
      const code = parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCharCode(code) : "";
    }
    return "";
  });
}

async function decryptPassword(payload) {
  if (!payload?.iv || !payload?.data) throw new Error("密码无效");
  const key = await getCryptoKey();
  const iv = base64ToUint8(payload.iv);
  const cipher = base64ToUint8(payload.data);
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
  return new TextDecoder().decode(plainBuf);
}

function base64ToUint8(str) {
  const binary = atob(str);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

let cachedCryptoKey = null;
const KEY_BASE64 = "Uml2ZXJzaWRlTGl0ZUtleQ=="; // aes-128 key base64 of "RiversideLiteKey"
async function getCryptoKey() {
  if (cachedCryptoKey) return cachedCryptoKey;
  const raw = base64ToUint8(KEY_BASE64);
  cachedCryptoKey = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  return cachedCryptoKey;
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

function isReportNotification(item) {
  if (item?.kind === "report") return true;
  const text = stripHtml([item?.summary, item?.html_message, item?.subject].filter(Boolean).join(" "));
  return /有新的举报等待处理/.test(text);
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
  const version = cachedState.version === "old" ? "old" : "new";
  const linkMode = cachedState.meowLinkMode || "thread";
  const target =
    linkMode === "none"
      ? ""
      : linkMode === "list"
      ? URLS[version].messages
      : URLS[version].messages;
  await maybeSendMeowPush(content, 1, {
    force: true,
    targetUrl: target,
    includeUrl: linkMode !== "none",
  });
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
  if (message?.type === "switchAccount") {
    (async () => {
      try {
        log("switchAccount message received", {
          user: message.username || "",
          hasPwd: Boolean(message.password),
          hasCaptcha: Boolean(message.captcha?.code),
        });
        await switchAccountLegacy(message.username, message.password, message.captcha);
        sendResponse({ ok: true });
      } catch (error) {
        console.error("switchAccount error", summarizeLoginError(error));
        sendResponse({
          ok: false,
          error: error?.message || "unknown",
          needCaptcha: Boolean(error?.needCaptcha),
          captcha: error?.captcha || null,
        });
      }
    })();
    return true; // keep port open for async response
  }
  if (message?.type === "getLoginCaptcha") {
    fetchLoginCaptchaInfo(message?.captcha || {})
      .then((info) => sendResponse({ ok: Boolean(info), captcha: info || null }))
      .catch((error) => {
        console.error("getLoginCaptcha failed", error);
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
    } else {
      // No open tab to read auth from; proactively adopt before first request
      const adopted = await ensureAuthorization();
      if (adopted && cachedState.authorizationHeader) {
        log("adopted auth before request");
      } else {
        log("no auth available before request");
      }
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
    // First retry: read latest Authorization from any open BBS tab (if the page refreshed token quietly)
    log("api 401, retrying with fresh auth");
    const freshAuth = await readAuthorizationFromPage();
    if (freshAuth && freshAuth !== cachedState.authorizationHeader) {
      await persistState({ ...cachedState, authorizationHeader: freshAuth });
      headers["Authorization"] = freshAuth;
      res = await doFetch();
    }
  }
  if (res.status === 401) {
    // Second retry: explicitly call adoptLegacyAuth to mint a new Authorization with current cookies
    log("api 401, trying adoptLegacyAuth");
    const adopted = await ensureAuthorization();
    if (adopted && cachedState.authorizationHeader) {
      headers["Authorization"] = cachedState.authorizationHeader;
      res = await doFetch();
    }
  }
  if (res.status === 401) {
    log("api still 401 after retries", { url });
    await persistState({ ...cachedState, authorizationHeader: "" });
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
    if (!res.ok) {
      if (res.status === 403) {
        const err = new Error("获取授权失败，可能需要校园网或 VPN");
        err.status = 403;
        throw err;
      }
      return false;
    }
    const data = await res.json();
    const auth = data?.data?.authorization || data?.authorization;
    if (auth) {
      log("adoptLegacyAuth succeeded");
      await persistState({ ...cachedState, authorizationHeader: auth });
      return true;
    }
  } catch (error) {
    console.error("adoptLegacyAuth failed", error);
    throw error;
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
