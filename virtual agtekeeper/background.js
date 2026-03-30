/* 
  Virtual Gatekeeper - Background Service Worker
  Developed by Moin Ul Haq
*/

// 1. BACKGROUND SERVICE WORKER (THE PERSISTENCE)
// High-priority setInterval triggered from the background script
setInterval(() => {
  chrome.tabs.query({ url: ["*://meet.google.com/*", "*://zoom.us/*", "*://*.zoom.us/*"] }, (tabs) => {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, { type: "BACKGROUND_SCAN" }).catch(() => { });
    });
  });
}, 1000);

// Use alarms to ensure the extension does not go to sleep
chrome.alarms.create('keepAlive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    console.log("[Virtual Gatekeeper] Background persistence active.");
  }
});

// Use chrome.runtime.onMessage to keep the content script 'awake'
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'PING') {
    sendResponse({ status: 'AWAKE' });
  } else if (message.type === 'TAB_HIDDEN') {
    console.log("[Virtual Gatekeeper] Background Mode Engaged.");
  }
});
