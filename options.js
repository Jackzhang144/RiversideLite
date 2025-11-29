const notificationsToggle = document.getElementById("notificationsToggle");
const versionNewRadio = document.getElementById("versionNew");
const versionOldRadio = document.getElementById("versionOld");

const DEFAULTS = {
  notificationsEnabled: true,
  version: "new", // Default to new version
};

function init() {
  // Load settings and update UI
  chrome.storage.local.get(DEFAULTS, (items) => {
    notificationsToggle.checked = Boolean(items.notificationsEnabled);
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
}

document.addEventListener("DOMContentLoaded", init);
