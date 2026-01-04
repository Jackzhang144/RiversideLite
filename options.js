const notificationsToggle = document.getElementById("notificationsToggle");
const versionNewRadio = document.getElementById("versionNew");
const versionOldRadio = document.getElementById("versionOld");
const meowToggle = document.getElementById("meowToggle");
const meowNicknameInput = document.getElementById("meowNickname");
const meowTestBtn = document.getElementById("meowTestBtn");
const meowTestStatus = document.getElementById("meowTestStatus");
const meowLinkNoneRadio = document.getElementById("meowLinkNone");
const meowLinkListRadio = document.getElementById("meowLinkList");
const meowLinkThreadRadio = document.getElementById("meowLinkThread");
const quickBoardsToggle = document.getElementById("quickBoardsToggle");
const quickBoardsInput = document.getElementById("quickBoardsInput");
const quickBoardsStatus = document.getElementById("quickBoardsStatus");
const switchUsernameInput = document.getElementById("switchUsername");
const switchPasswordInput = document.getElementById("switchPassword");
const switchBtn = document.getElementById("switchBtn");
const switchStatus = document.getElementById("switchStatus");
const accountSaveBtn = document.getElementById("accountSaveBtn");
const accountStatus = document.getElementById("accountStatus");
const accountList = document.getElementById("accountList");
const captchaArea = document.getElementById("captchaArea");
const captchaImg = document.getElementById("loginCaptchaImg");
const captchaInput = document.getElementById("loginCaptchaInput");
const captchaRefreshBtn = document.getElementById("captchaRefreshBtn");
const KEY_RAW = "RiversideLiteKey"; // 16-byte AES key
let cachedCryptoKey = null;
let cachedCaptchaInfo = null;
const uiLog = (...args) => {
  const ts = new Date().toISOString();
  console.log(`[RiversideLite][options][${ts}]`, ...args);
};

function refreshAccountListFromStorage() {
  chrome.storage.local.get({ accounts: [], activeUsername: "" }, ({ accounts, activeUsername }) => {
    renderAccountList(accounts || [], activeUsername || "");
  });
}

function formatQuickBoards(list) {
  if (!Array.isArray(list) || !list.length) return "";
  return list
    .filter((item) => item && item.name && item.id)
    .map((item) => `${item.name}=${item.id}`)
    .join("\n");
}

function parseQuickBoards(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const boards = [];
  const errors = [];
  lines.forEach((line, index) => {
    const parsed = splitBoardLine(line);
    const name = parsed[0].trim();
    const idText = parsed[1].trim();
    const id = Number(idText);
    if (!name || !idText || !Number.isInteger(id) || id <= 0) {
      errors.push(`第 ${index + 1} 行格式不正确`);
      return;
    }
    boards.push({ name, id });
  });
  return { boards, errors };
}

function splitBoardLine(line) {
  const separators = ["=", ",", "|"];
  for (const sep of separators) {
    const idx = line.indexOf(sep);
    if (idx > -1) {
      return [line.slice(0, idx), line.slice(idx + 1)];
    }
  }
  return ["", ""];
}

function saveQuickBoards() {
  if (quickBoardsInput.disabled) return;
  const { boards, errors } = parseQuickBoards(quickBoardsInput.value);
  if (errors.length) {
    quickBoardsStatus.textContent = errors[0];
    quickBoardsStatus.style.color = "#c5221f";
    return;
  }
  chrome.storage.local.set({ quickBoards: boards }, () => {
    quickBoardsStatus.textContent = boards.length ? "已保存" : "已清空";
    quickBoardsStatus.style.color = "#137333";
  });
}

function init() {
  // Load settings and update UI
  chrome.storage.local.get(STORAGE_DEFAULTS, (items) => {
    notificationsToggle.checked = Boolean(items.notificationsEnabled);
    meowToggle.checked = Boolean(items.meowPushEnabled);
    meowNicknameInput.value = items.meowNickname || "";
    meowNicknameInput.disabled = !meowToggle.checked;
    const linkMode = items.meowLinkMode || STORAGE_DEFAULTS.meowLinkMode;
    if (linkMode === "none") {
      meowLinkNoneRadio.checked = true;
    } else if (linkMode === "list") {
      meowLinkListRadio.checked = true;
    } else {
      meowLinkThreadRadio.checked = true;
    }
    if (items.version === "old") {
      versionOldRadio.checked = true;
    } else {
      versionNewRadio.checked = true;
    }
    quickBoardsToggle.checked = Boolean(items.quickBoardsEnabled);
    quickBoardsInput.disabled = !quickBoardsToggle.checked;
    quickBoardsInput.value = formatQuickBoards(items.quickBoards || []);
    renderAccountList(items.accounts || [], items.activeUsername || "");
  });

  // Save notification setting on change
  notificationsToggle.addEventListener("change", () => {
    chrome.storage.local.set({ notificationsEnabled: notificationsToggle.checked });
  });

  // Save version setting on change
  versionNewRadio.addEventListener("change", () => {
    if (versionNewRadio.checked) {
      chrome.storage.local.set({ version: "new" });
    }
  });

  versionOldRadio.addEventListener("change", () => {
    if (versionOldRadio.checked) {
      chrome.storage.local.set({ version: "old" });
    }
  });

  meowToggle.addEventListener("change", () => {
    chrome.storage.local.set({ meowPushEnabled: meowToggle.checked });
    meowNicknameInput.disabled = !meowToggle.checked;
  });

  meowLinkNoneRadio.addEventListener("change", () => {
    if (meowLinkNoneRadio.checked) {
      chrome.storage.local.set({ meowLinkMode: "none" });
    }
  });

  meowLinkListRadio.addEventListener("change", () => {
    if (meowLinkListRadio.checked) {
      chrome.storage.local.set({ meowLinkMode: "list" });
    }
  });

  meowLinkThreadRadio.addEventListener("change", () => {
    if (meowLinkThreadRadio.checked) {
      chrome.storage.local.set({ meowLinkMode: "thread" });
    }
  });

  quickBoardsToggle.addEventListener("change", () => {
    const enabled = quickBoardsToggle.checked;
    quickBoardsInput.disabled = !enabled;
    chrome.storage.local.set({ quickBoardsEnabled: enabled });
  });

  quickBoardsInput.addEventListener("change", () => {
    saveQuickBoards();
  });

  switchBtn?.addEventListener("click", async () => {
    const username = switchUsernameInput.value.trim();
    const password = switchPasswordInput.value;
    if (!username || !password) {
      switchStatus.textContent = "请填写用户名和密码";
      switchStatus.style.color = "#c5221f";
      return;
    }
    switchBtn.disabled = true;
    switchBtn.textContent = "切换中...";
    switchStatus.textContent = "";
    try {
      uiLog("switch submit", {
        username,
        hasPwd: Boolean(password),
        hasCaptcha: Boolean(cachedCaptchaInfo?.hash),
        hasAuth: Boolean(cachedCaptchaInfo?.auth),
      });
      const captchaValue = (captchaInput && captchaInput.value.trim()) || "";
      const captchaPayload = buildCaptchaSubmitPayload(captchaValue);
      const { ok, error, needCaptcha, captcha } = await sendMessagePromise({
        type: "switchAccount",
        username,
        password,
        captcha: captchaPayload,
      });
      if (!ok) {
        if (needCaptcha) {
          uiLog("switch needs captcha", { captcha: summarizeCaptcha(captcha) });
          await ensureCaptchaLoaded(false, captcha);
          switchStatus.textContent = error || "需要验证码，请输入图中的字符后重试";
          switchStatus.style.color = "#c5221f";
          return;
        }
        throw new Error(error || "切换失败，请稍后重试");
      }
      switchPasswordInput.value = "";
      clearCaptcha();
      chrome.storage.local.set({ activeUsername: username });
      switchStatus.textContent = "切换成功，请刷新页面";
      switchStatus.style.color = "#137333";
    } catch (err) {
      uiLog("switch failed", err);
      switchStatus.textContent = err.message || "切换失败";
      switchStatus.style.color = "#c5221f";
    } finally {
      switchBtn.disabled = false;
      switchBtn.textContent = "切换账号";
    }
  });

  meowNicknameInput.addEventListener("change", () => {
    chrome.storage.local.set({ meowNickname: meowNicknameInput.value.trim() });
  });

  captchaRefreshBtn?.addEventListener("click", async () => {
    uiLog("manual captcha refresh");
    await ensureCaptchaLoaded(true);
  });

  accountSaveBtn?.addEventListener("click", () => {
    const username = switchUsernameInput.value.trim();
    const password = switchPasswordInput.value;
    if (!username || !password) {
      accountStatus.textContent = "请填写用户名和密码";
      accountStatus.style.color = "#c5221f";
      return;
    }
    encryptPassword(password)
      .then((encrypted) => {
        chrome.storage.local.get(STORAGE_DEFAULTS, (items) => {
          const accounts = Array.isArray(items.accounts) ? [...items.accounts] : [];
          const existingIndex = accounts.findIndex((acc) => acc.username === username);
          const entry = { username, passwordEnc: encrypted };
          if (existingIndex >= 0) {
            accounts[existingIndex] = entry;
          } else {
            accounts.push(entry);
          }
          chrome.storage.local.set({ accounts }, () => {
            accountStatus.textContent = "已保存账号";
            accountStatus.style.color = "#137333";
            renderAccountList(accounts, items.activeUsername || "");
          });
        });
      })
      .catch((err) => {
        accountStatus.textContent = err?.message || "保存失败";
        accountStatus.style.color = "#c5221f";
      });
  });

  meowTestBtn.addEventListener("click", async () => {
    meowTestBtn.disabled = true;
    meowTestBtn.textContent = "发送中...";
    meowTestStatus.textContent = "";
    try {
      const { ok, error } = await sendMessagePromise({ type: "sendMeowTest" });
      if (!ok) {
        throw new Error(error || "测试发送失败");
      }
      meowTestStatus.textContent = "测试发送成功，请在 MeoW 查看。";
      meowTestStatus.style.color = "#137333";
    } catch (err) {
      meowTestStatus.textContent = err.message || "测试发送失败";
      meowTestStatus.style.color = "#c5221f";
    } finally {
      meowTestBtn.disabled = false;
      meowTestBtn.textContent = "发送测试";
    }
  });

  renderAccountList(STORAGE_DEFAULTS.accounts, STORAGE_DEFAULTS.activeUsername);
}

document.addEventListener("DOMContentLoaded", init);
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.accounts || changes.activeUsername) {
    refreshAccountListFromStorage();
  }
});

function summarizeCaptcha(info) {
  if (!info) return { hasHash: false, hasAuth: false, hasLoginhash: false };
  return {
    hasHash: Boolean(info.hash),
    hasAuth: Boolean(info.auth),
    hasLoginhash: Boolean(info.loginhash),
  };
}

function normalizeCaptchaInfo(info = {}) {
  if (!info) return null;
  const normalized = {
    hash: info.hash || "",
    url: info.url || "",
    image: info.image || "",
    loginhash: info.loginhash || "",
    modid: info.modid || "",
    auth: info.auth || "",
  };
  if (!normalized.hash && !normalized.url && !normalized.image) return null;
  return normalized;
}

function buildCaptchaContext(info) {
  if (!info) return null;
  const context = {
    hash: info.hash || "",
    loginhash: info.loginhash || "",
    modid: info.modid || "",
    auth: info.auth || "",
  };
  if (!context.hash && !context.loginhash && !context.auth) return null;
  return context;
}

function buildCaptchaSubmitPayload(code) {
  if (!code || !cachedCaptchaInfo?.hash) return undefined;
  return {
    hash: cachedCaptchaInfo.hash,
    loginhash: cachedCaptchaInfo.loginhash || "",
    modid: cachedCaptchaInfo.modid || "",
    auth: cachedCaptchaInfo.auth || "",
    code,
  };
}

async function ensureCaptchaLoaded(force = false, preset = null) {
  if (!captchaArea) return;
  uiLog("ensureCaptchaLoaded", {
    force,
    cached: summarizeCaptcha(cachedCaptchaInfo),
    preset: summarizeCaptcha(preset),
  });
  if (preset && (preset.hash || preset.url || preset.image)) {
    showCaptcha(preset);
    return;
  }
  if (!force && cachedCaptchaInfo?.hash) {
    captchaArea.style.display = "flex";
    return;
  }
  try {
    const message = { type: "getLoginCaptcha" };
    const context = buildCaptchaContext(preset || cachedCaptchaInfo);
    if (context) message.captcha = context;
    const { ok, captcha } = await sendMessagePromise(message);
    if (ok && captcha) {
      showCaptcha(captcha);
    } else {
      captchaArea.style.display = "flex";
      switchStatus.textContent = "获取验证码失败，请稍后再试";
      switchStatus.style.color = "#c5221f";
    }
  } catch (error) {
    captchaArea.style.display = "flex";
    switchStatus.textContent = "获取验证码失败，请稍后再试";
    switchStatus.style.color = "#c5221f";
  }
}

function showCaptcha(info = {}) {
  if (!captchaArea) return;
  cachedCaptchaInfo = normalizeCaptchaInfo(info);
  const url = cachedCaptchaInfo?.image || cachedCaptchaInfo?.url || "";
  captchaArea.style.display = "flex";
  if (captchaImg) {
    const finalUrl = url
      ? url.startsWith("data:")
        ? url
        : `${url}${url.includes("?") ? "&" : "?"}_=${Date.now()}`
      : "";
    captchaImg.src = finalUrl;
    captchaImg.alt = url ? "验证码" : "无法加载验证码";
  }
  if (captchaInput) {
    captchaInput.value = "";
    captchaInput.focus();
  }
}

function clearCaptcha() {
  if (!captchaArea) return;
  cachedCaptchaInfo = null;
  captchaArea.style.display = "none";
  if (captchaImg) {
    captchaImg.src = "";
  }
  if (captchaInput) {
    captchaInput.value = "";
  }
}

function renderAccountList(accounts, activeUsername = "") {
  accountList.innerHTML = "";
  if (!accounts.length) {
    const empty = document.createElement("div");
    empty.className = "status-text";
    empty.textContent = "暂无已保存账号";
    accountList.appendChild(empty);
    return;
  }

  accounts.forEach((acc, idx) => {
    const row = document.createElement("div");
    row.className = "account-row";

    const left = document.createElement("div");
    left.className = "account-meta";
    const name = document.createElement("div");
    name.className = "account-name";
    name.textContent = acc.username;
    left.appendChild(name);
    if (activeUsername === acc.username) {
      const badge = document.createElement("span");
      badge.className = "account-badge";
      badge.textContent = "当前";
      left.appendChild(badge);
    }

    const actions = document.createElement("div");
    actions.className = "account-actions";

    const switchBtnEl = document.createElement("button");
    switchBtnEl.type = "button";
    switchBtnEl.textContent = "切换";
    switchBtnEl.addEventListener("click", async () => {
      switchStatus.textContent = "";
      try {
        const res = await sendMessagePromise({ type: "switchAccount", username: acc.username });
        if (!res?.ok) {
          if (res?.needCaptcha) {
            await ensureCaptchaLoaded(false, res.captcha);
            throw new Error(res?.error || "需要验证码，请上方输入密码与验证码后重试");
          }
          throw new Error(res?.error || "切换失败");
        }
        switchStatus.textContent = "切换成功，请刷新页面";
        switchStatus.style.color = "#137333";
        chrome.storage.local.set({ activeUsername: acc.username });
      } catch (err) {
        switchStatus.textContent = err.message || "切换失败";
        switchStatus.style.color = "#c5221f";
      }
    });

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.textContent = "删除";
    delBtn.className = "ghost";
    delBtn.addEventListener("click", () => {
      const next = accounts.filter((_, i) => i !== idx);
      const nextState = { accounts: next };
      if (activeUsername === acc.username) {
        nextState.activeUsername = "";
      }
      chrome.storage.local.set(nextState, () => {
        renderAccountList(next, nextState.activeUsername || activeUsername);
      });
    });

    actions.appendChild(switchBtnEl);
    actions.appendChild(delBtn);

    row.appendChild(left);
    row.appendChild(actions);
    accountList.appendChild(row);
  });
}

async function encryptPassword(plain) {
  if (!plain) throw new Error("密码为空");
  const key = await getCryptoKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plain);
  const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  return {
    iv: arrayBufferToBase64(iv),
    data: arrayBufferToBase64(cipherBuf),
  };
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

async function getCryptoKey() {
  if (cachedCryptoKey) return cachedCryptoKey;
  const raw = new TextEncoder().encode(KEY_RAW);
  cachedCryptoKey = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  return cachedCryptoKey;
}
