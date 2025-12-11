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

const DEFAULTS = {
  notificationsEnabled: true,
  version: "new", // Default to new version
  meowPushEnabled: false,
  meowNickname: "",
  meowLinkMode: "none",
};

function init() {
  // Load settings and update UI
  chrome.storage.local.get(DEFAULTS, (items) => {
    notificationsToggle.checked = Boolean(items.notificationsEnabled);
    meowToggle.checked = Boolean(items.meowPushEnabled);
    meowNicknameInput.value = items.meowNickname || "";
    meowNicknameInput.disabled = !meowToggle.checked;
    const linkMode = items.meowLinkMode || DEFAULTS.meowLinkMode;
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

  meowNicknameInput.addEventListener("change", () => {
    chrome.storage.local.set({ meowNickname: meowNicknameInput.value.trim() });
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
}

document.addEventListener("DOMContentLoaded", init);
