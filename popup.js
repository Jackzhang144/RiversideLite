const STATUS = document.getElementById("status");
const LIST = document.getElementById("list");
const HOME_BTN = document.getElementById("homeBtn");
const OPTIONS_BTN = document.getElementById("btnOptions");
const ACCOUNT_SELECT = document.getElementById("accountSelect");
const ACCOUNT_SWITCH_BTN = document.getElementById("accountSwitchBtn");

const THREAD_URL_NEW = (threadId) => `https://bbs.uestc.edu.cn/thread/${threadId}`;
const THREAD_URL_OLD = (threadId) =>
  `https://bbs.uestc.edu.cn/forum.php?mod=viewthread&tid=${threadId}`;
const THREAD_REDIRECT_OLD = (threadId, postId) =>
  `https://bbs.uestc.edu.cn/forum.php?mod=redirect&goto=findpost&ptid=${threadId}&pid=${postId}`;
const FALLBACK_URL_NEW = "https://bbs.uestc.edu.cn/messages/posts";
const FALLBACK_URL_OLD = "https://bbs.uestc.edu.cn/home.php?mod=space&do=notice";
const CHAT_URL_NEW_BASE = "https://bbs.uestc.edu.cn/messages/chat";
const CHAT_URL_OLD_BASE = "https://bbs.uestc.edu.cn/home.php?mod=space&do=pm";
let currentVersion = "new";

HOME_BTN?.addEventListener("click", openHome);
OPTIONS_BTN?.addEventListener("click", openOptions);
ACCOUNT_SWITCH_BTN?.addEventListener("click", switchAccountFromPopup);
init();

function init() {
  chrome.storage.local.get(
    { version: "new", accounts: [], activeUsername: "" },
    ({ version, accounts, activeUsername }) => {
    currentVersion = version === "old" ? "old" : "new";
      populateAccountSelect(accounts || [], activeUsername || "");
    fetchSummary().catch((error) => {
      console.error(error);
      setStatus("加载失败，请检查是否已登录。", true);
    });
    }
  );
}

async function fetchSummary() {
  setStatus("加载中...");
  const { ok, data, error, status } = await chrome.runtime.sendMessage({
    type: "fetchSummary",
  });
  if (!ok) {
    const code = status || extractStatusCode(error);
    if (code === 401) {
      setStatus("未登录或登录已失效，请先在站点登录后重试。", true);
      return;
    }
    if (code === 403) {
      renderForbiddenNotice();
      return;
    }
    setStatus(code ? `加载失败（${code}）` : "加载失败，请稍后重试。", true);
    return;
  }

  // API 响应包裹了 code/message? 兼容直接取 data.data/new_notifications
  if (data?.code && data.code !== 0) {
    if (data.code === 403) {
      renderForbiddenNotice();
      return;
    }
    setStatus(`加载失败（${data.code}）`, true);
    return;
  }

  const payload = data?.data && data.code !== undefined ? data.data : data;
  const notifications = Array.isArray(payload?.new_notifications) ? payload.new_notifications : [];
  const chats = Array.isArray(payload?.new_chats) ? payload.new_chats : [];
  const chatCount = payload?.new_messages?.chat || 0;

  renderLists(notifications, chats, chatCount);
}

function renderLists(notifications, chats, chatCount) {
  LIST.innerHTML = "";
  setStatus("");
  HOME_BTN?.classList.remove("hidden");

  if (chats.length || chatCount) {
    LIST.appendChild(makeSectionTitle("站内信"));
    if (chats.length) {
      chats.forEach((chat) => {
        const container = document.createElement("div");
        container.className = "item";
        container.addEventListener("click", () => openChat(chat));
        const title = document.createElement("div");
        title.className = "title";
        const author = normalizeText(chat.to_username || chat.last_author || "");
        const subject = normalizeText(chat.subject || "查看站内信");
        title.textContent = [author, subject].filter(Boolean).join(" · ");
        const summary = document.createElement("div");
        summary.className = "summary";
        summary.textContent = sliceText(normalizeText(chat.last_summary || ""), 120);
        container.appendChild(title);
        container.appendChild(summary);
        LIST.appendChild(container);
      });
    } else if (chatCount) {
      const placeholder = document.createElement("div");
      placeholder.className = "item";
      placeholder.addEventListener("click", () => openChat());
      const title = document.createElement("div");
      title.className = "title";
      title.textContent = `您有 ${chatCount} 条新站内信`;
      placeholder.appendChild(title);
      LIST.appendChild(placeholder);
    }
  }

  if (notifications.length) {
    LIST.appendChild(makeSectionTitle("提醒"));
    notifications.forEach((item) => {
      const container = document.createElement("div");
      container.className = "item";
      container.addEventListener("click", () => openItem(item, container));

      const title = document.createElement("div");
      title.className = "title";
      title.textContent = normalizeText(item.subject || "查看详情");

      const summary = document.createElement("div");
      summary.className = "summary";
      summary.textContent = sliceText(stripHtml(item.summary || item.html_message || ""), 120);

      const closeBtn = document.createElement("button");
      closeBtn.className = "read-btn";
      closeBtn.textContent = "×";
      closeBtn.title = "标记已读";
      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        markRead(item, container);
      });

      container.appendChild(title);
      container.appendChild(summary);
      container.appendChild(closeBtn);
      LIST.appendChild(container);
    });
  }

  if (!LIST.children.length) {
    setStatus("暂无未读消息");
    chrome.runtime.sendMessage({ type: "clearBadge" }, () => {});
  } else {
    // 有未读则确保徽标存在
    chrome.runtime.sendMessage({ type: "ensureBadge" }, () => {});
  }
}

function setStatus(text, isError = false) {
  HOME_BTN?.classList.remove("hidden");
  STATUS.innerHTML = "";
  STATUS.textContent = text;
  STATUS.className = isError ? "error" : "";
}

function extractStatusCode(raw) {
  if (!raw) return null;
  const match = String(raw).match(/\b(\d{3})\b/);
  if (!match) return null;
  const code = Number(match[1]);
  return Number.isNaN(code) ? null : code;
}

function normalizeText(text) {
  const decoded = decodeEntities(text || "");
  return decoded.replace(/&nbsp;?/gi, " ").replace(/\u00a0/g, " ").trim();
}

function stripHtml(html) {
  if (!html) return "";
  const div = document.createElement("div");
  div.innerHTML = html;
  return normalizeText(div.textContent || "");
}

function sliceText(text, max = 120) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function formatDate(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, "0")}:${d
    .getMinutes()
    .toString()
    .padStart(2, "0")}`;
}

async function markRead(item, container) {
  try {
    const { ok, error } = await chrome.runtime.sendMessage({
      type: "markRead",
      id: item.id,
      kind: item.kind,
    });
    if (!ok) throw new Error(error || "mark read failed");
    container.remove();
    if (!LIST.children.length) {
      setStatus("暂无未读消息");
      chrome.runtime.sendMessage({ type: "clearBadge" }, () => {});
    } else {
      // 读完后立刻刷新徽标计数
      chrome.runtime.sendMessage({ type: "ensureBadge" }, () => {});
    }
  } catch (error) {
    console.error(error);
    setStatus("标记失败，请稍后再试。", true);
  }
}

async function openItem(item, container) {
  await markRead(item, container);
  const useOld = currentVersion === "old";

  if (isRateNotification(item)) {
    // 评分提醒不跳转，只做已读清除
    return;
  }

  if (isTaskCompletionNotification(item)) {
    // 任务完成提示无需跳转
    return;
  }

  const url = buildNotificationTarget(item, useOld);
  await openOrFocusUrl(url);
  window.close();
}

async function openOptions() {
  try {
    await chrome.runtime.openOptionsPage();
  } catch (error) {
    console.error(error);
  }
}

function populateAccountSelect(accounts, activeUsername = "") {
  if (!ACCOUNT_SELECT) return;
  ACCOUNT_SELECT.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "选择账号（可在选项页管理）";
  ACCOUNT_SELECT.appendChild(placeholder);
  accounts.forEach((acc) => {
    const opt = document.createElement("option");
    opt.value = acc.username;
    opt.textContent = acc.username + (acc.username === activeUsername ? "（当前）" : "");
    if (acc.username === activeUsername) opt.selected = true;
    ACCOUNT_SELECT.appendChild(opt);
  });
}

async function switchAccountFromPopup() {
  if (!ACCOUNT_SELECT) return;
  const username = ACCOUNT_SELECT.value;
  if (!username) {
    setAccountButtonState("请选择账号", "#b20000");
    return;
  }
  ACCOUNT_SWITCH_BTN.disabled = true;
  ACCOUNT_SWITCH_BTN.textContent = "切换中...";
  try {
    const res = await sendMessagePromise({ type: "switchAccount", username });
    if (!res?.ok) throw new Error(res?.error || "切换失败");
    setAccountButtonState("切换成功", "#137333", true);
    setTimeout(() => {
      resetAccountButton();
    }, 2000);
  } catch (err) {
    setAccountButtonState("切换失败", "#b20000");
  } finally {
    if (!ACCOUNT_SWITCH_BTN.classList.contains("success")) {
      ACCOUNT_SWITCH_BTN.disabled = false;
      ACCOUNT_SWITCH_BTN.textContent = "切换";
      ACCOUNT_SWITCH_BTN.style.background = "";
      ACCOUNT_SWITCH_BTN.style.borderColor = "";
    }
  }
}

function sendMessagePromise(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message || "sendMessage failed"));
        return;
      }
      resolve(response);
    });
  });
}

function setAccountButtonState(text, color, success = false) {
  ACCOUNT_SWITCH_BTN.textContent = text;
  ACCOUNT_SWITCH_BTN.style.background = color;
  ACCOUNT_SWITCH_BTN.style.borderColor = color;
  ACCOUNT_SWITCH_BTN.style.color = "#fff";
  ACCOUNT_SWITCH_BTN.disabled = true;
  ACCOUNT_SWITCH_BTN.classList.toggle("success", success);
}

function resetAccountButton() {
  ACCOUNT_SWITCH_BTN.textContent = "切换";
  ACCOUNT_SWITCH_BTN.style.background = "";
  ACCOUNT_SWITCH_BTN.style.borderColor = "";
  ACCOUNT_SWITCH_BTN.style.color = "";
  ACCOUNT_SWITCH_BTN.disabled = false;
  ACCOUNT_SWITCH_BTN.classList.remove("success");
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

function openChat(chat) {
  // 新版接口暂不可用，统一跳转旧版私信页面
  const url = buildLegacyChatUrl(chat);
  chrome.tabs.create({ url });
  window.close();
}

// 新版私信页面暂不可用，保留函数以便恢复时使用
// function buildNewChatUrl(chat) {
//   return chat?.conversation_id
//     ? `${CHAT_URL_NEW_BASE}/${chat.conversation_id}`
//     : CHAT_URL_NEW_BASE;
// }

function buildLegacyChatUrl(chat) {
  if (chat?.to_uid) {
    return `${CHAT_URL_OLD_BASE}&subop=view&touid=${chat.to_uid}#last`;
  }
  if (chat?.conversation_id) {
    return `${CHAT_URL_OLD_BASE}&subop=view&plid=${chat.conversation_id}&type=1#last`;
  }
  return CHAT_URL_OLD_BASE;
}

async function openHome() {
  try {
    const url = currentVersion === "old" ? "https://bbs.uestc.edu.cn/forum.php" : "https://bbs.uestc.edu.cn/new";
    const matched = await chrome.tabs.query({ url: `${url}*` });
    if (matched.length && matched[0].id) {
      const tab = matched[0];
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url });
    }
    window.close();
  } catch (error) {
    console.error(error);
  }
}

async function openOrFocusUrl(targetUrl) {
  if (!targetUrl) return;
  try {
    const tabs = await chrome.tabs.query({ url: "*://bbs.uestc.edu.cn/*" });
    if (tabs.length) {
      const tab = tabs[0];
      await chrome.tabs.update(tab.id, { active: true, url: targetUrl });
      await chrome.windows.update(tab.windowId, { focused: true });
      return;
    }
    await chrome.tabs.create({ url: targetUrl });
  } catch (error) {
    console.error("openOrFocusUrl failed", error);
    await chrome.tabs.create({ url: targetUrl });
  }
}

function makeSectionTitle(text) {
  const div = document.createElement("div");
  div.className = "section-title";
  div.textContent = text;
  return div;
}

function renderForbiddenNotice() {
  LIST.innerHTML = "";
  HOME_BTN?.classList.add("hidden");
  STATUS.className = "error status-forbidden";
  STATUS.innerHTML = `
    <div class="status-line">外网访问受限，请在校园网或 WebVPN 环境下访问。</div>
    <div class="status-actions">
      <button class="link-btn" id="btnWebvpn">WebVPN 跳转</button>
      <button class="link-btn" id="btnProxy">代理跳转</button>
    </div>
  `;

  const useOld = currentVersion === "old";
  const webvpnUrl = useOld
    ? "https://webvpn.uestc.edu.cn/https/77726476706e69737468656265737421f2f552d232357b447d468ca88d1b203b/forum.php"
    : "https://webvpn.uestc.edu.cn/https/77726476706e69737468656265737421f2f552d232357b447d468ca88d1b203b/new";
  const proxyUrl = useOld ? "https://bbs.uestcer.org/forum.php" : "https://bbs.uestcer.org/new";

  document.getElementById("btnWebvpn")?.addEventListener("click", () => {
    chrome.tabs.create({ url: webvpnUrl });
    window.close();
  });
  document.getElementById("btnProxy")?.addEventListener("click", () => {
    chrome.tabs.create({ url: proxyUrl });
    window.close();
  });
}

function buildNotificationTarget(item, useOld) {
  if (!item) return useOld ? FALLBACK_URL_OLD : FALLBACK_URL_NEW;
  const summaryText = stripHtml([item?.summary, item?.html_message, item?.subject].filter(Boolean).join(" "));
  if (item.kind === "report" || /有新的举报等待处理/.test(summaryText)) {
    return "https://bbs.uestc.edu.cn/forum.php?mod=modcp&action=report";
  }
  return buildThreadUrl(item, useOld);
}

function buildThreadUrl(item, useOld) {
  const { threadId, postId, page } = extractThreadLocation(item);
  if (!threadId && !postId) return useOld ? FALLBACK_URL_OLD : FALLBACK_URL_NEW;
  if (!threadId && postId && !useOld) {
    return buildGotoUrl(null, postId);
  }
  if (useOld) {
    if (postId) return THREAD_REDIRECT_OLD(threadId, postId);
    return THREAD_URL_OLD(threadId);
  }
  if (postId && !page) {
    // 当缺少页码时使用 /goto 路由以定位到具体楼层
    return buildGotoUrl(threadId, postId);
  }
  const url = new URL(THREAD_URL_NEW(threadId));
  if (page) url.searchParams.set("page", page);
  if (postId) url.hash = `post-${postId}`;
  return url.toString();
}

function buildGotoUrl(threadId, postId) {
  const base = "https://bbs.uestc.edu.cn";
  if (!postId) return threadId ? `${base}/thread/${threadId}` : base;
  if (threadId) return `${base}/goto/${threadId}/${postId}`;
  return `${base}/goto/${postId}`;
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
