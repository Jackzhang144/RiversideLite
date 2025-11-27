const toggle = document.getElementById("notificationsToggle");
const DEFAULTS = { notificationsEnabled: true };

function init() {
  chrome.storage.local.get(DEFAULTS, (items) => {
    toggle.checked = Boolean(items.notificationsEnabled);
  });

  toggle.addEventListener("change", () => {
    chrome.storage.local.set({ notificationsEnabled: toggle.checked });
  });
}

document.addEventListener("DOMContentLoaded", init);
