document.addEventListener('DOMContentLoaded', () => {
  const verifiedCount = document.getElementById('verified-count');
  const intruderCount = document.getElementById('intruder-count');
  const gatekeeperToggle = document.getElementById('gatekeeper-toggle');
  const rosterUpload = document.getElementById('roster-upload');
  const dropZone = document.getElementById('drop-zone');
  const rosterStatus = document.getElementById('roster-status');
  const rosterIndicator = document.getElementById('roster-indicator');
  const exportBtn = document.getElementById('export-report');
  const clearBtn = document.getElementById('clear-data');

  const automuteToggle = document.getElementById('automute-toggle');
  const muteAllBtn = document.getElementById('mute-all');
  const muteSuccess = document.getElementById('mute-success');
  const uploadIconWrapper = document.getElementById('upload-icon-wrapper');
  const uploadText = document.getElementById('upload-text');
  const permissionsNotice = document.getElementById('permissions-notice');
  const gatekeeperGroup = gatekeeperToggle.closest('.toggle-group');
  const adminActions = document.getElementById('admin-actions');

  // Load initial state
  function loadState() {
    chrome.storage.local.get(['gatekeeperEnabled', 'automuteEnabled', 'roster', 'stats', 'sessionData'], (data) => {
      if (data.gatekeeperEnabled !== undefined) {
        gatekeeperToggle.checked = data.gatekeeperEnabled;
      }
      if (data.automuteEnabled !== undefined) {
        automuteToggle.checked = data.automuteEnabled;
      }
      if (data.roster && data.roster.length > 0) {
        rosterStatus.textContent = "Roster Active - Auto-Admit Enabled";
        rosterIndicator.className = "indicator status-green";
        dropZone.classList.add('active-roster');
        setRosterActiveUI(true);
      } else {
        rosterStatus.textContent = "No Roster - Manual Entry Only";
        rosterIndicator.className = "indicator status-red";
        dropZone.classList.remove('active-roster');
        setRosterActiveUI(false);
      }
      if (data.stats) {
        verifiedCount.textContent = data.stats.verified || 0;
        intruderCount.textContent = data.stats.intruders || 0;
      }

      // Request current role from content script
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_ROLE' });
        }
      });
    });
  }

  loadState();

  // Toggle Gatekeeper Mode
  gatekeeperToggle.addEventListener('change', () => {
    chrome.storage.local.set({ gatekeeperEnabled: gatekeeperToggle.checked });
    // Notify content script
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'TOGGLE_GATEKEEPER',
          enabled: gatekeeperToggle.checked
        });
      }
    });
  });

  // Toggle Auto-Mute
  automuteToggle.addEventListener('change', () => {
    chrome.storage.local.set({ automuteEnabled: automuteToggle.checked });
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'TOGGLE_AUTOMUTE',
          enabled: automuteToggle.checked
        });
      }
    });
  });

  // Mute All Command
  muteAllBtn.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        // Toggle the lock state locally for the command
        const currentLock = muteAllBtn.getAttribute('data-lock') === 'true';
        const newLock = !currentLock;
        muteAllBtn.setAttribute('data-lock', newLock);

        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'MUTE_ALL',
          lockMic: newLock
        });

        // Success Feedback
        muteSuccess.textContent = newLock ? "Mic Lock ACTIVE - All Students Muted" : "Mic Lock RELEASED";
        muteSuccess.classList.remove('hidden');
        muteAllBtn.classList.toggle('btn-danger', newLock);

        setTimeout(() => {
          muteSuccess.classList.add('hidden');
        }, 3000);
      }
    });
  });

  // Handle Roster Upload
  dropZone.addEventListener('click', () => rosterUpload.click());

  rosterUpload.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const content = event.target.result;
        const roster = parseRoster(content);
        chrome.storage.local.set({ roster: roster }, () => {
          rosterStatus.textContent = "Roster Active - Auto-Admit Enabled";
          rosterIndicator.className = "indicator status-green";
          dropZone.classList.add('active-roster');
          setRosterActiveUI(true);
        });
      };
      reader.readAsText(file);
    }
  });

  function parseRoster(text) {
    const lines = text.split(/\r?\n/);
    const roster = [];
    lines.forEach(line => {
      if (line.trim()) {
        const parts = line.split(',').map(p => p.trim());
        if (parts.length >= 1) {
          roster.push({
            name: parts[0],
            roll: parts[1] || 'N/A'
          });
        }
      }
    });
    return roster;
  }

  function setRosterActiveUI(active) {
    if (active) {
      uploadIconWrapper.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#2ecc71" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
      uploadText.textContent = "Roster Successfully Loaded";
      uploadText.style.color = "#2ecc71";
    } else {
      uploadIconWrapper.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
      uploadText.textContent = "Upload CSV/Text Roster";
      uploadText.style.color = "rgba(255, 255, 255, 0.8)";
    }
  }

  // Export Report
  exportBtn.addEventListener('click', () => {
    chrome.storage.local.get(['sessionData', 'roster'], (data) => {
      const logs = data.sessionData || {};
      const roster = data.roster || [];

      if (Object.keys(logs).length === 0 && roster.length === 0) {
        alert('No attendance data or roster found.');
        return;
      }
      generateCSV(logs, roster);
    });
  });

  function generateCSV(logs, roster) {
    let csvContent = "Virtual Gatekeeper - Official Attendance Report | Managed by Moin Ul Haq\n";
    csvContent += "Student Name,Roll Number,Status (Present/Absent/Intruder),Join Time,Total Duration (Mins),Architect\n";

    // Create a set of names that have logs
    const loggedNames = new Set(Object.keys(logs).map(n => n.toLowerCase().trim()));

    // 1. Process Logs (PRESENT and INTRUDER)
    Object.values(logs).forEach(log => {
      csvContent += `${log.name},${log.roll},${log.status},${log.startTime},${log.totalMinutes},Moin Ul Haq\n`;
    });

    // 2. Process ABSENT logic (Roster students NOT in logs)
    roster.forEach(student => {
      const nameKey = student.name.toLowerCase().trim();
      if (!loggedNames.has(nameKey)) {
        csvContent += `${student.name},${student.roll},ABSENT,N/A,0,Moin Ul Haq\n`;
      }
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `Attendance_Report_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  // Clear Session Data (Deep Wipe)
  clearBtn.addEventListener('click', () => {
    if (confirm('Are you sure you want to deep clear all session data and the roster?')) {
      chrome.storage.local.clear(() => {
        // Re-initialize with empty defaults
        chrome.storage.local.set({
          sessionData: {},
          roster: [],
          stats: { verified: 0, intruders: 0 },
          gatekeeperEnabled: false,
          automuteEnabled: false
        }, () => {
          loadState();
          alert('All data wiped. Extension reset.');
        });
      });
    }
  });

  // Listen for updates from content script
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'STATS_UPDATE') {
      verifiedCount.textContent = message.verified;
      intruderCount.textContent = message.intruders;
    } else if (message.type === 'ROLE_UPDATE') {
      updateUIForRole(message.isHost);
    }
  });

  function updateUIForRole(isHost) {
    if (isHost) {
      permissionsNotice.classList.add('hidden');
      gatekeeperGroup.classList.remove('disabled-feature');
      adminActions.classList.remove('disabled-feature');
    } else {
      permissionsNotice.classList.remove('hidden');
      gatekeeperGroup.classList.add('disabled-feature');
      adminActions.classList.add('disabled-feature');
    }
  }
});
