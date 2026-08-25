// Clicking the toolbar icon opens the app in a full tab (a popup is too small for a table).
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('app.html') });
});
