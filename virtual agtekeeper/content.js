/* 
  Virtual Gatekeeper - Official Content Script 
  Developed by Moin Ul Haq
*/

let authorizedRoster = [];
let sessionData = {}; // Renamed from sessionLogs
let gatekeeperEnabled = false;
let automuteEnabled = false;
let stats = { verified: 0, intruders: 0 };
let lastScanTime = 0;
let admissionCheckInterval = null; 
let durationInterval = null; 
let roleCheckInterval = null; // New: periodic role check
let micLockActive = false; 
let isHost = false; // New: track user role
const SCAN_INTERVAL = 2500; 

// Initialize from storage
chrome.storage.local.get(['roster', 'sessionData', 'gatekeeperEnabled', 'automuteEnabled', 'stats'], (data) => {
  authorizedRoster = data.roster || [];
  sessionData = data.sessionData || {};
  gatekeeperEnabled = data.gatekeeperEnabled || false;
  automuteEnabled = data.automuteEnabled || false;
  stats = data.stats || { verified: 0, intruders: 0 };
  
  startTracking();
  startAdmissionMonitor(); 
  startDurationTimer(); 
  startRoleMonitor(); // New: Start checking for host permissions
  startDeepBackgroundScan(); // Background persistence
});

// Start tracking participants
function startTracking() {
  const isMeet = window.location.hostname.includes('meet.google.com');
  const isZoom = window.location.hostname.includes('zoom.us');

  if (isMeet) {
    observeMeet();
  } else if (isZoom) {
    observeZoom();
  }
}

// Faster check for Admission Popups (1s interval)
function startAdmissionMonitor() {
  if (admissionCheckInterval) clearInterval(admissionCheckInterval);
  admissionCheckInterval = setInterval(() => {
    const isMeet = window.location.hostname.includes('meet.google.com');
    const isZoom = window.location.hostname.includes('zoom.us');
    if (isMeet || isZoom) {
      checkAdmissionPopup();
    }
  }, 1000);
}

function checkAdmissionPopup() {
  // Use querySelectorAll to find all buttons robustly
  const buttons = Array.from(document.querySelectorAll('button'));
  
  const admitBtn = buttons.find(btn => {
    const text = (btn.innerText || btn.getAttribute('aria-label') || "").toLowerCase();
    return text.includes("admit") || text.includes("allow");
  });

  const denyBtn = buttons.find(btn => {
    const text = (btn.innerText || btn.getAttribute('aria-label') || "").toLowerCase();
    return text.includes("deny") || text.includes("decline") || text.includes("reject") || text.includes("remove");
  });

  if (admitBtn || denyBtn) {
    let requesterName = "Guest";
    // Detection logic for the requester's name
    const popup = admitBtn?.closest('div[role="dialog"]') || 
                  denyBtn?.closest('div[role="dialog"]') || 
                  admitBtn?.closest('.participants-section-container') ||
                  admitBtn?.parentElement?.parentElement;

    if (popup) {
      const textContent = popup.innerText || "";
      const match = textContent.match(/^(.+?)\s+(wants to join|is requesting|is asking)/i);
      if (match && match[1]) {
        requesterName = match[1].trim();
      } else {
        // Fallback: Find the first span that looks like a name
        const spans = popup.querySelectorAll('span, .participant-name');
        for (let s of spans) {
          const sText = s.innerText.trim();
          if (sText.length > 2 && !sText.includes("join") && !sText.includes("Admit") && !sText.includes("Deny") && !sText.includes("Remove")) {
            requesterName = sText;
            break;
          }
        }
      }
    }

    const isAuthorized = authorizedRoster.some(student => 
      requesterName.toLowerCase().trim() === student.name.toLowerCase().trim()
    );

    if (isAuthorized && admitBtn) {
      console.log(`[Virtual Gatekeeper] Auto-Admitting: ${requesterName}`);
      admitBtn.click();
      
      // Task 3: Trigger immediate tracking for admitted student
      const student = authorizedRoster.find(s => requesterName.toLowerCase().trim() === s.name.toLowerCase().trim());
      if (!sessionData[requesterName]) {
        sessionData[requesterName] = {
          name: requesterName,
          roll: student ? student.roll : 'N/A',
          status: 'PRESENT',
          startTime: new Date().toLocaleTimeString(),
          totalMinutes: 0,
          isPresent: true
        };
        chrome.storage.local.set({ sessionData });
      }

      // Task 2: Immediate Auto-Mute on Join
      if (automuteEnabled) {
        setTimeout(() => triggerImmediateMute(requesterName), 1500); // Small delay for participant list to update
      }
    } else if (!isAuthorized && gatekeeperEnabled && denyBtn) {
      console.log(`[Virtual Gatekeeper] Auto-Denying: ${requesterName}`);
      denyBtn.click();
      
      // Update intruder count and storage
      stats.intruders++;
      chrome.storage.local.set({ stats });
      chrome.runtime.sendMessage({ type: 'STATS_UPDATE', ...stats });
    }
  }
}

// TASK 1: professional 60-second Timing Loop
function startDurationTimer() {
  if (durationInterval) clearInterval(durationInterval);
  durationInterval = setInterval(() => {
    updateAttendanceDuration();
  }, 60000);
}

function updateAttendanceDuration() {
  const isMeet = window.location.hostname.includes('meet.google.com');
  const participants = isMeet 
    ? document.querySelectorAll("div[data-participant-id]") 
    : document.querySelectorAll(".participant-list-item");

  participants.forEach(el => {
    let name = '';
    if (isMeet) {
      name = el.querySelector("span[jsname='re6Sdb']")?.textContent || el.getAttribute('aria-label') || '';
    } else {
      name = el.querySelector(".participant-name")?.textContent || '';
    }

    if (!name) return;

    // Check against Roster
    const student = authorizedRoster.find(s => name.toLowerCase().trim() === s.name.toLowerCase().trim());
    
    if (!sessionData[name]) {
      sessionData[name] = {
        name: name,
        roll: student ? student.roll : 'N/A',
        status: student ? 'PRESENT' : 'INTRUDER',
        startTime: new Date().toLocaleTimeString(),
        totalMinutes: 0,
        isPresent: true
      };
    } else {
      sessionData[name].isPresent = true;
      // Task 1.3: Increment totalMinutes for PRESENT students
      if (sessionData[name].status === 'PRESENT') {
        sessionData[name].totalMinutes += 1;
      }
    }
  });

  // Sync to storage (Task 1.4)
  chrome.storage.local.set({ sessionData: sessionData });
  console.log(`[Virtual Gatekeeper] Professional Attendance Synced - ${Object.keys(sessionData).length} logs active.`);
}

// Google Meet Logic
function observeMeet() {
  const observer = new MutationObserver((mutations) => {
    const now = Date.now();
    if (now - lastScanTime < SCAN_INTERVAL) return;
    lastScanTime = now;

    // Optimized selector for Google Meet
    const participants = document.querySelectorAll("div[data-participant-id]");
    if (participants.length > 0) {
      processParticipants(participants, 'MEET');
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

// Zoom Logic (Web Client)
function observeZoom() {
  const observer = new MutationObserver((mutations) => {
    const now = Date.now();
    if (now - lastScanTime < SCAN_INTERVAL) return;
    lastScanTime = now;

    const participants = document.querySelectorAll(".participant-list-item");
    if (participants.length > 0) {
      processParticipants(participants, 'ZOOM');
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

function processParticipants(participantElements, platform) {
  let currentVerified = 0;
  let currentIntruders = 0;
  const now = new Date();

  participantElements.forEach(el => {
    // Performance: Skip if already checked and name hasn't changed
    if (el.classList.contains('vg-checked')) return;

    let name = '';
    if (platform === 'MEET') {
      name = el.querySelector("span[jsname='re6Sdb']")?.textContent || 
             el.getAttribute('aria-label') || '';
    } else {
      name = el.querySelector(".participant-name")?.textContent || '';
    }

    if (!name) return;

    const isAuthorized = authorizedRoster.some(student => 
      name.toLowerCase().trim() === student.name.toLowerCase().trim()
    );

    el.classList.add('vg-checked');

    if (isAuthorized) {
      currentVerified++;
      handleAuthorized(name, now);
      el.classList.remove('vg-unverified');
      el.classList.add('vg-verified');
    } else {
      currentIntruders++;
      handleUnauthorized(name, now, el);
      el.classList.add('vg-unverified');
      el.classList.remove('vg-verified');
    }

    // Apply Auto-Mute if enabled
    if (automuteEnabled) {
      handleAutoMute(el, platform);
    }
  });

  // Update stats and persistence
  if (currentVerified !== stats.verified || currentIntruders !== stats.intruders) {
    stats.verified = currentVerified;
    stats.intruders = currentIntruders;
    chrome.storage.local.set({ stats });
    chrome.runtime.sendMessage({ type: 'STATS_UPDATE', ...stats });
  }
}

// TASK: Role & Permission Detection
function startRoleMonitor() {
  if (roleCheckInterval) clearInterval(roleCheckInterval);
  checkUserRole(); // Initial check
  roleCheckInterval = setInterval(checkUserRole, 2000); // Increased frequency to 2s
}

function checkUserRole() {
  const isMeet = window.location.hostname.includes('meet.google.com');
  const isZoom = window.location.hostname.includes('zoom.us');
  let hostFound = false;

  if (isMeet) {
    const hostBtn = document.querySelector("button[aria-label*='Host controls'], button[jsname='v6by9d']");
    const muteAllBtn = Array.from(document.querySelectorAll('button')).find(b => 
      b.innerText?.includes('Mute all') || b.getAttribute('aria-label')?.includes('Mute all')
    );
    // Also check for Admit button directly as a sign of host/co-host power
    const admitBtn = Array.from(document.querySelectorAll('button')).find(b => 
      b.innerText?.toLowerCase().includes("admit") || b.innerText?.toLowerCase().includes("allow")
    );
    if (hostBtn || muteAllBtn || admitBtn) hostFound = true;
  } else if (isZoom) {
    const zoomMuteAll = document.querySelector(".mute-all-button") || 
                        Array.from(document.querySelectorAll('button')).find(b => 
                          b.innerText?.includes("Mute All") || b.innerText?.includes("Mute all")
                        );
    const zoomAdmit = Array.from(document.querySelectorAll('button')).find(b => 
      b.innerText?.includes("Admit") || b.innerText?.includes("admit")
    );
    if (zoomMuteAll || zoomAdmit) hostFound = true;
  }

  if (hostFound !== isHost) {
    isHost = hostFound;
    chrome.runtime.sendMessage({ type: 'ROLE_UPDATE', isHost: isHost });
    console.log(`[Virtual Gatekeeper] Role Transition: User is now ${isHost ? 'HOST/CO-HOST' : 'PARTICIPANT'}. Attendance preserved.`);
  }
}

// Helper for immediate muting after admission
function triggerImmediateMute(name) {
  const isMeet = window.location.hostname.includes('meet.google.com');
  const participants = document.querySelectorAll(isMeet ? "div[data-participant-id]" : ".participant-list-item");
  
  participants.forEach(el => {
    const elName = isMeet 
      ? (el.querySelector("span[jsname='re6Sdb']")?.textContent || el.getAttribute('aria-label') || '')
      : (el.querySelector(".participant-name")?.textContent || '');
    
    if (elName.toLowerCase().includes(name.toLowerCase())) {
      handleAutoMute(el, isMeet ? 'MEET' : 'ZOOM');
    }
  });
}

function handleAuthorized(name, time) {
  if (!sessionData[name]) {
    const student = authorizedRoster.find(s => name.toLowerCase().trim() === s.name.toLowerCase().trim());
    sessionData[name] = {
      name: name,
      roll: student ? student.roll : 'N/A',
      status: 'PRESENT',
      startTime: time.toLocaleTimeString(),
      totalMinutes: 0,
      isPresent: true
    };
  } else {
    sessionData[name].isPresent = true;
  }
}

function handleUnauthorized(name, time, element) {
  if (!sessionData[name]) {
    sessionData[name] = {
      name: name,
      roll: 'N/A',
      status: 'INTRUDER',
      startTime: time.toLocaleTimeString(),
      totalMinutes: 0,
      isPresent: true
    };
  } else {
    sessionData[name].isPresent = true;
  }

  if (gatekeeperEnabled) {
    console.log(`[Virtual Gatekeeper] Gatekeeper Mode: Unauthorized entry detected - ${name}`);
  }
}

// Receive messages from popup
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'TOGGLE_GATEKEEPER') {
    gatekeeperEnabled = message.enabled;
  } else if (message.type === 'TOGGLE_AUTOMUTE') {
    automuteEnabled = message.enabled;
  } else if (message.type === 'MUTE_ALL') {
    triggerMuteAll(message.lockMic);
  } else if (message.type === 'GET_ROLE') {
    chrome.runtime.sendMessage({ type: 'ROLE_UPDATE', isHost: isHost });
  } else if (message.type === 'BACKGROUND_SCAN') {
    // 2. High-priority trigger from background script bypassing timer throttle
    if (document.hidden && gatekeeperEnabled) {
       const admitBtn = document.querySelector('button[aria-label*="Admit"], button[aria-label="Admit"], .zm-btn--primary');
       if (admitBtn) {
           const container = admitBtn.closest('div[role="dialog"]') || document.body;
           const name = container.innerText || "";
           if (authorizedRoster.some(s => name.toLowerCase().includes(s.name.toLowerCase()))) {
               admitBtn.click();
               console.log("[Virtual Gatekeeper] Aggressive Background Admit for: " + name);
               if (automuteEnabled) setTimeout(() => triggerImmediateMute(name), 1500);
           }
       }
    }
  }
});

async function triggerMuteAll(lockMic = false) {
  const isMeet = window.location.hostname.includes('meet.google.com');
  micLockActive = lockMic;

  if (isMeet) {
    // 1. Native Mute All
    let muteAllBtn = Array.from(document.querySelectorAll('button'))
      .find(btn => btn.textContent?.includes('Mute all') || btn.getAttribute('aria-label')?.includes('Mute all'));
    
    if (muteAllBtn) {
      muteAllBtn.click();
      setTimeout(() => {
        const confirmBtn = document.querySelector("button[jsname='LgbsSe']");
        if (confirmBtn && confirmBtn.textContent?.includes('Mute')) confirmBtn.click();
      }, 500);
    }

    // 2. Mic Lock (Host Controls)
    if (lockMic) {
      toggleMicLock(true);
    }
  } else if (isZoom) {
    // Zoom Web Mute All
    let zoomMuteAll = document.querySelector(".mute-all-button") || 
                      Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes("Mute All"));
    
    if (zoomMuteAll) {
      zoomMuteAll.click();
      setTimeout(() => {
        // Zoom puts "Yes" in a confirmation dialog
        let confirmYes = Array.from(document.querySelectorAll('button')).find(b => b.innerText === "Yes" || b.innerText === "Mute All");
        if (confirmYes) confirmYes.click();
      }, 500);
    }
  }
}

async function toggleMicLock(enabled) {
  // Logic to toggle "Microphone access" in Host Controls
  let hostBtn = document.querySelector("button[aria-label*='Host controls'], button[jsname='v6by9d']");
  if (hostBtn) {
    hostBtn.click();
    await new Promise(r => setTimeout(r, 800));
    
    const micToggle = Array.from(document.querySelectorAll('input[type="checkbox"], button[role="switch"]'))
      .find(el => el.getAttribute('aria-label')?.includes('Microphone access') || el.innerText?.includes('Microphone access'));
    
    if (micToggle) {
      const isCurrentlyEnabled = micToggle.checked || micToggle.getAttribute('aria-checked') === 'true';
      if (enabled && isCurrentlyEnabled) {
         micToggle.click(); // Turn OFF
         console.log("[Virtual Gatekeeper] Mic Lock Active: Microphones Disabled.");
      } else if (!enabled && !isCurrentlyEnabled) {
         micToggle.click(); // Turn ON
         console.log("[Virtual Gatekeeper] Mic Lock Released: Microphones Allowed.");
      }
    }
    
    // Close panel
    hostBtn.click();
  }
}

function handleAutoMute(element, platform) {
  if (!automuteEnabled) return;

  // Logic to find individual mute buttons for a specific participant
  if (platform === 'MEET') {
    const muteBtn = element.querySelector("button[aria-label*='Mute']");
    if (muteBtn && !muteBtn.disabled) {
      muteBtn.click();
    }
  } else if (platform === 'ZOOM') {
    const muteBtn = element.querySelector(".mute-button");
    if (muteBtn) muteBtn.click();
  }
}

// ======== BACKGROUND & INACTIVE MODE ========

// 4. THE "MINIMIZED" LOGIC SNIPPET
// Force execution even if the tab is minimized
function startDeepBackgroundScan() {
    setInterval(() => {
        // Only run if Gatekeeper Mode is ON
        if (!gatekeeperEnabled) return;

        // Bypassing focus: Programmatic search for join requests
        const admitBtn = document.querySelector('button[aria-label*="Admit"], button[aria-label="Admit"], .zm-btn--primary');
        
        if (admitBtn) {
            // Background verification logic
            const container = admitBtn.closest('div[role="dialog"]') || document.body;
            const name = container.innerText || "";

            if (authorizedRoster.some(s => name.toLowerCase().includes(s.name.toLowerCase()))) {
                admitBtn.click();
                console.log("[Virtual Gatekeeper] Automated Background Admit for: " + name);
                
                if (automuteEnabled) {
                    setTimeout(() => triggerImmediateMute(name), 1500);
                }
            }
        }
    }, 1000); 
}

// 3. Use the Page Visibility API to bypass 'Sleep Mode' and force the script to run even if document.hidden is true.
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        chrome.runtime.sendMessage({ type: "TAB_HIDDEN" }).catch(() => {});
    }
});

// Continuously ping background script to keep it alive
setInterval(() => {
    chrome.runtime.sendMessage({ type: "PING" }).catch(() => {});
}, 25000);
