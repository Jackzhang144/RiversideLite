const STORAGE_DEFAULTS = {
  notificationsEnabled: true,
  version: "new",
  meowPushEnabled: false,
  meowNickname: "",
  meowLinkMode: "none",
  accounts: [],
  activeUsername: "",
  lastSummaryCache: null, // 缓存最近一次弹窗摘要，提升首屏速度
  quickBoardsEnabled: false,
  quickBoards: [],
};

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
