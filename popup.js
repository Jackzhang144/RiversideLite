const STATUS = document.getElementById("status");
const LIST = document.getElementById("list");
const HOME_BTN = document.getElementById("homeBtn");

const THREAD_URL_NEW = (threadId) => `https://bbs.uestc.edu.cn/thread/${threadId}`;
const THREAD_URL_OLD = (threadId) =>
  `https://bbs.uestc.edu.cn/forum.php?mod=viewthread&tid=${threadId}`;
const FALLBACK_URL_NEW = "https://bbs.uestc.edu.cn/messages/posts";
const FALLBACK_URL_OLD = "https://bbs.uestc.edu.cn/home.php?mod=space&do=notice";
const CHAT_URL_NEW_BASE = "https://bbs.uestc.edu.cn/messages/chat";
const CHAT_URL_OLD_BASE = "https://bbs.uestc.edu.cn/home.php?mod=space&do=pm";
let currentVersion = "new";

HOME_BTN?.addEventListener("click", openHome);
init();

function init() {
  chrome.storage.local.get({ version: "new" }, ({ version }) => {
    currentVersion = version === "old" ? "old" : "new";
    fetchSummary().catch((error) => {
      console.error(error);
      setStatus("加载失败，请检查是否已登录。", true);
    });
  });
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
  return (text || "").replace(/&nbsp;?/gi, " ").replace(/\u00a0/g, " ").trim();
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

  const url =
    item.kind === "report" || /有新的举报等待处理/.test(item.summary || item.html_message || "")
      ? "https://bbs.uestc.edu.cn/forum.php?mod=modcp&action=report"
      : item.thread_id
      ? useOld
        ? THREAD_URL_OLD(item.thread_id)
        : THREAD_URL_NEW(item.thread_id)
      : useOld
      ? FALLBACK_URL_OLD
      : FALLBACK_URL_NEW;
  chrome.tabs.create({ url });
  window.close();
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

function makeSectionTitle(text) {
  const div = document.createElement("div");
  div.className = "section-title";
  div.textContent = text;
  return div;
}

function renderForbiddenNotice() {
  LIST.innerHTML = "";
  STATUS.className = "error";
  STATUS.textContent = "外网访问受限，请在校园网或 WebVPN 环境下访问";
}
