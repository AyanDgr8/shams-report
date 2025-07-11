// script.js

/* global axios */
const form = document.getElementById('filterForm');
const loadingEl = document.getElementById('loading');
const errorBox = document.getElementById('errorBox');
const table = document.getElementById('resultTable');
const statsBox = document.getElementById('stats');
const csvBtn = document.getElementById('csvBtn');
const fetchBtn = document.getElementById('fetchBtn');

// Track the selected tenant account globally so we can build recording URLs
let tenantAccount = '';

// Columns whose raw value should NEVER be interpreted as epoch or duration
const RAW_COLUMNS = new Set([
  'caller_id_number',
  'caller_id_name',
  'callee_id_number',
  'agent_ext',
  'lead_number',
  'agent_extension',
  'to',
  'caller id number',
  'caller id name',
  'callee id number',
  'agent extension'
]);

// Columns that should have filter inputs (or dropdown)
const FILTER_COLUMNS = new Set([
  'Callee ID number',
  'Called Time',
  'Queue / Campaign Name',
  'Call ID',
  'Caller Id Number',
  'Agent Disposition',
  'Disposition',
  // there is no standalone "Agent Extension" header; the above covers it
  'Agent name',
  'Type',
  'Campaign Type',
  'Status',
  'Abandoned'
]);

function show(el) { el.classList.remove('is-hidden'); }
function hide(el) { el.classList.add('is-hidden'); }

// Convert seconds → HH:MM:SS or D days HH:MM:SS
function secondsToHMS(sec) {
  const total = parseInt(sec, 10);
  if (Number.isNaN(total)) return sec;
  const days = Math.floor(total / 86400);
  const rem = total % 86400;
  const h = Math.floor(rem / 3600).toString().padStart(2, '0');
  const m = Math.floor((rem % 3600) / 60).toString().padStart(2, '0');
  const s = (rem % 60).toString().padStart(2, '0');
  return days ? `${days} day${days > 1 ? 's' : ''} ${h}:${m}:${s}` : `${h}:${m}:${s}`;
}

function isoToLocal(dateStr) {
  // Always display Dubai Time (Asia/Dubai) irrespective of client or server TZ
  return new Date(dateStr).toLocaleString('en-GB', { timeZone: 'Asia/Dubai' });
}

// Convert a <input type="datetime-local"> value assumed to be in Dubai local time
// into a proper ISO-8601 string (UTC) so the backend receives the right window.
function inputToDubaiIso(val) {
  if (!val) return '';
  const [datePart, timePart = '00:00'] = val.split('T'); // "YYYY-MM-DD" & "HH:MM"
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);
  // Asia/Dubai is UTC+4 with no daylight saving; subtract 4 h to get UTC.
  const utcMillis = Date.UTC(year, month - 1, day, hour - 4, minute);
  return new Date(utcMillis).toISOString();
}

// Required column order for the combined Queue report
const HEADERS = [
  'Type',
  'Call ID',
  'Queue / Campaign Name',
  'Called Time',
  'Caller Id Number',
  'Caller Id / Lead Name',
  'Answered time',
  'Hangup time',
  'Wait Duration',
  'Talk Duration',
  'Agent Disposition',
  'Callee ID number',
  'Status',
  'Campaign Type',
  'Abandoned',
  'Agent History',
  'Queue History',
  'Recording'            // consolidated playback column now placed last
];

// Additional headers for Campaign Activity report
const CAMPAIGN_HEADERS = [
  'Callee ID number',
  'Agent name',
  'Recording',
  'Status',
];

// Merge campaign headers into main list (no duplicates)
CAMPAIGN_HEADERS.forEach(h => {
  if (!HEADERS.includes(h)) HEADERS.push(h);
  const l = h.toLowerCase();
  if (l.includes('number') || l.includes('name')) RAW_COLUMNS.add(l);
});

HEADERS.forEach(h => {
  const l = h.toLowerCase();
  if (l.includes('number') || l.includes('name')) RAW_COLUMNS.add(l);
});

// Helper to wrap arbitrary HTML in an eye button that opens a modal
function createEyeBtn(innerHtml) {
  const id = 'popup_' + Math.random().toString(36).slice(2, 9);
  return `<button class="button is-small is-rounded eye-btn" data-target="${id}" title="View">&#128065;</button>` +
         `<div id="${id}" class="popup-content" style="display:none">${innerHtml}</div>`;
}

// Show a centered modal using Bulma to display supplied HTML
function showModal(contentHtml) {
  const modal = document.createElement('div');
  modal.className = 'modal is-active';
  modal.innerHTML = `
    <div class="modal-background"></div>
    <div class="modal-content" style="max-height:90vh; overflow:auto;">
      <div class="box">${contentHtml}</div>
    </div>
    <button class="modal-close is-large" aria-label="close"></button>`;
  const close = () => document.body.removeChild(modal);
  modal.querySelector('.modal-background').addEventListener('click', close);
  modal.querySelector('.modal-close').addEventListener('click', close);
  document.body.appendChild(modal);
}

// Attach a single delegated listener for all current & future eye buttons
if (!window.__eyeDelegationAttached) {
  document.addEventListener('click', e => {
    const btn = e.target.closest('.eye-btn');
    if (!btn) return;
    const target = document.getElementById(btn.dataset.target);
    if (target) {
      showModal(target.innerHTML);
    }
  });
  window.__eyeDelegationAttached = true;
}

// Convert Agent / Queue history arrays into a small HTML table for display
function historyToHtml(history) {
  if (!Array.isArray(history) || !history.length) return '';

  // Define the desired column order & headers
  const COLS = [
    { key: 'last_attempt', label: 'Last Attempt' },
    { key: 'name', label: 'Name' },
    { key: 'ext', label: 'Extension' },
    { key: 'type', label: 'Type' },
    { key: 'event', label: 'Event' },
    { key: 'connected', label: 'Connected' },
    { key: 'queue_name', label: 'Queue Name' }
  ];

  const thead = `<thead><tr>${COLS.map(c => `<th>${c.label}</th>`).join('')}</tr></thead>`;

  const rows = history.map(h => {
    const cells = COLS.map(c => {
      let val = '';
      if (c.key === 'name') {
        val = `${h.first_name || ''} ${h.last_name || ''}`.trim();
      } else if (c.key === 'last_attempt') {
        if (h.last_attempt) {
          const ms = h.last_attempt > 10_000_000_000 ? h.last_attempt : h.last_attempt * 1000;
          val = isoToLocal(new Date(ms).toISOString());
        }
      } else if (c.key === 'connected') {
        val = h.connected ? 'Yes' : 'No';
      } else {
        val = h[c.key] ?? '';
      }
      return `<td>${val}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');

  const tableHtml = `<table class="history-table">${thead}<tbody>${rows}</tbody></table>`;
  return createEyeBtn(tableHtml);
}

// Convert Queue history array into an HTML table (Date, Queue Name)
function queueHistoryToHtml(history) {
  if (!Array.isArray(history) || !history.length) return '';
  const thead = '<thead><tr><th>Date</th><th>Queue Name</th></tr></thead>';
  const rows = history.map(h => {
    let date = '';
    if (h.ts) {
      const ms = h.ts > 10_000_000_000 ? h.ts : h.ts * 1000;
      date = isoToLocal(new Date(ms).toISOString());
    }
    const q = h.queue_name ?? '';
    return `<tr><td>${date}</td><td>${q}</td></tr>`;
  }).join('');
  const tableHtml = `<table class="history-table">${thead}<tbody>${rows}</tbody></table>`;
  return createEyeBtn(tableHtml);
}

// Convert Lead history array into an HTML table (Last Attempt, First Name, Last Name, Extension/Number, Event, Hangup Cause)
function leadHistoryToHtml(history) {
  if (!Array.isArray(history) || !history.length) return '';
  const thead = '<thead><tr><th>Last Attempt</th><th>First Name</th><th>Last Name</th><th>Extension/Number</th><th>Event</th><th>Hangup Cause</th></tr></thead>';
  const rows = history.map(h => {
    // last attempt timestamp
    let last = '';
    if (h.last_attempt) {
      const ms = h.last_attempt > 10_000_000_000 ? h.last_attempt : h.last_attempt * 1000;
      last = isoToLocal(new Date(ms).toISOString());
    }
    const fn = h.first_name || h.agent?.first_name || '';
    const ln = h.last_name || h.agent?.last_name || '';
    const ext = h.ext || h.agent?.ext || '';
    const evt = h.type || h.event || '';
    const cause = h.hangup_cause || '';
    return `<tr><td>${last}</td><td>${fn}</td><td>${ln}</td><td>${ext}</td><td>${evt}</td><td>${cause}</td></tr>`;
  }).join('');
  const tableHtml = `<table class="history-table">${thead}<tbody>${rows}</tbody></table>`;
  return createEyeBtn(tableHtml);
}

// Determine Abandoned (Yes/No) for inbound calls based on agent_history
function computeAbandoned(row) {
  // Only relevant for inbound calls
  let history = row.agent_history;
  if (typeof history === 'string') {
    try { history = JSON.parse(history); } catch { history = []; }
  }
  if (!Array.isArray(history) || !history.length) return 'NO';

  let connected = false;
  let star7 = false;
  history.forEach(h => {
    if (h.connected) connected = true;
    if ((h.event || '').toString().includes('*7')) star7 = true;
  });

  if (connected) return 'NO';
  // Abandoned is YES only when not connected AND no *7 event
  return (!connected && !star7) ? 'YES' : 'NO';
}

// Normalize inbound/outbound API rows to the unified schema expected by HEADERS
function normalizeRow(row, source) {
  if (source === 'camp') {
    return {
      'Type': 'Campaign',
      'Call ID': row.call_id ?? row.callid ?? '',
      'Queue / Campaign Name': row.campaign_name ?? '',
      'Campaign Type': row.campaign_type ?? '',
      // 'Lead name': row.lead_name ?? '',
      // 'Lead first name': row.lead_first_name ?? '',
      // 'Lead last name': row.lead_last_name ?? '',
      'Caller Id / Lead Name': row.lead_name ?? '',
      'Callee ID number': row.lead_number ?? '',
      // 'Lead ticket id': row.lead_ticket_id ?? '',
      // 'Lead type': row.lead_type ?? '',
      'Agent name': row.agent_name ?? '',
      'Caller Id Number': row.agent_extension ?? '',
      'Talk Duration': row.agent_talk_time ?? '',
      'Agent Disposition': row.agent_disposition ?? '',
      'Agent History': `${historyToHtml(row.agent_history ?? [])}${leadHistoryToHtml(row.lead_history ?? [])}`,
      'Called Time': row.timestamp ?? row.datetime ?? '',
      'Answered time': '',
      'Hangup time': '',
      'Wait Duration': '',
      'Recording': row.media_recording_id ?? row.recording_filename ?? '',
      'Status': row.status ?? '',
      // 'Customer wait time SLA': row.customer_wait_time_sla ?? '',
      // 'Customer wait time over SLA': row.customer_wait_time_over_sla ?? '',
      'Disposition': row.disposition ?? '',
      // 'Hangup cause': row.hangup_cause ?? '',
      'Lead disposition': row.lead_disposition ?? '',
      'Abandoned': '',
    };
  }

  // inbound / outbound queues
  const isOutbound = source === 'out';
  return {
    'Type': isOutbound ? 'Outbound' : 'Inbound',
    'Call ID': row.call_id ?? row.callid ?? '',
    'Queue / Campaign Name': row.queue_name ?? '',
    'Called Time': row.called_time ?? '',
    'Caller Id Number': row.caller_id_number ?? '',
    'Caller Id / Lead Name': row.caller_id_name ?? '',
    'Answered time': row.answered_time ?? '',
    'Hangup time': row.hangup_time ?? '',
    'Wait Duration': row.wait_duration ?? '',
    'Talk Duration': row.talked_duration ?? '',
    'Callee ID number': isOutbound ? (row.to ?? '') : (row.callee_id_number ?? ''),
    'Agent Disposition': row.agent_disposition ?? '',
    'Queue History': queueHistoryToHtml(row.queue_history ?? []),
    'Agent History': historyToHtml(row.agent_history ?? []),
    'Status': '',
    'Campaign Type': '',
    'Abandoned': isOutbound ? '' : computeAbandoned(row),
    'Recording': row.media_recording_id ?? row.recording_filename ?? ''
  };
}

// Render using the fixed header order so we preserve column naming / sequence
function renderReportTable(records) {
  if (!records.length) {
    table.innerHTML = '<caption>No results for selected range.</caption>';
    return;
  }
  const thead = `<thead><tr>${HEADERS.map(h => `<th>${h}</th>`).join('')}</tr></thead>`;
  const tbody = `<tbody>${records.map(rec => {
    const type = rec['Type'];
    const rowClass = type === 'Inbound' ? 'row-inbound' : type === 'Outbound' ? 'row-outbound' : 'row-campaign';
    return `<tr class="${rowClass}">` + HEADERS.map(h => {
      let v = rec[h];
      if (v == null) v = '';

      // Render audio player for Recording column
      if (h === 'Recording') {
        if (v) {
          const src = `/api/recordings/${v}?account=${encodeURIComponent(tenantAccount)}`;
          const metaUrl = `/api/recordings/${v}/meta?account=${encodeURIComponent(tenantAccount)}`;
          // We'll fetch meta asynchronously and fill span#dur_<id>
          return `<td><audio controls preload="metadata" src="${src}" data-meta="${metaUrl}"></audio> <span class="rec-dur" id="dur_${v.replace(/[^\w]/g,'')}"></span></td>`;
        }
        return '<td></td>';
      }

      // Skip any transformation for caller/callee IDs & names
      if (RAW_COLUMNS.has(h.toLowerCase())) {
        return `<td>${v}</td>`;
      }

      if (typeof v === 'object') {
        v = JSON.stringify(v);
      } else if (typeof v === 'number') {
        if (v > 1_000_000_000) {
          const ms = v > 10_000_000_000 ? v : v * 1000;
          v = isoToLocal(new Date(ms).toISOString());
        } else {
          v = secondsToHMS(v);
        }
      } else if (typeof v === 'string' && /^\d+$/.test(v)) {
        const num = Number(v);
        if (num > 1_000_000_000) {
          const ms = num > 10_000_000_000 ? num : num * 1000;
          v = isoToLocal(new Date(ms).toISOString());
        } else {
          v = secondsToHMS(num);
        }
      } else if (typeof v === 'string' && /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/.test(v)) {
        v = isoToLocal(v);
      }
      return `<td>${v}</td>`;
    }).join('') + '</tr>';
  }).join('')}</tbody>`;
  table.innerHTML = thead + tbody;

  // After table rendered, fetch durations for any audio elements that don't yet have them
  const audioEls = Array.from(table.querySelectorAll('audio[data-meta]'));

  const MAX_CONCURRENT = 5;
  let idx = 0;

  async function worker() {
    while (idx < audioEls.length) {
      const el = audioEls[idx++];
      const spanId = 'dur_' + el.src.match(/recordings\/([^?]+)/)[1].replace(/[^\w]/g,'');
      const span = document.getElementById(spanId);
      if (!span || span.textContent) continue;
      try {
        const resp = await axios.get(el.dataset.meta);
        const dur = resp.data?.duration;
        if (typeof dur === 'number') {
          span.textContent = ` Total Time :  ${secondsToHMS(Math.round(dur))}`;
        }
      } catch {}
    }
  }

  // Kick off limited parallel workers
  Array.from({ length: Math.min(MAX_CONCURRENT, audioEls.length) }).forEach(worker);
}

let lastRecords = [];
let currentFiltered = [];

// Create filter UI dynamically once records are available
function buildFilters() {
  const grid = document.getElementById('filtersGrid');
  if (!grid) return;
  // Build only if empty
  if (grid.childElementCount) return;
  HEADERS.filter(c => FILTER_COLUMNS.has(c)).forEach(col => {
    const colId = col.replace(/\s+/g, '_');
    const wrapper = document.createElement('div');
    // 6 per row on desktop (2/12 each), 3 per row on tablet, 2 per row on mobile
    wrapper.className = 'column is-2-desktop is-one-third-tablet is-half-mobile';
    if (col === 'Type') {
      wrapper.innerHTML = `<div class="field"><label class="label is-small">${col}</label><div class="select is-small is-fullwidth"><select data-col="${col}" id="filter_${colId}"><option value="">All</option><option>Inbound</option><option>Outbound</option><option>Campaign</option></select></div></div>`;
    } else if (col === 'Status') {
      wrapper.innerHTML = `<div class="field"><label class="label is-small">${col}</label><div class="select is-small is-fullwidth"><select data-col="${col}" id="filter_${colId}"><option value="">All</option><option>Success</option><option>Failure</option><option>Cooloff</option></select></div></div>`;
    } else if (col === 'Campaign Type') {
      wrapper.innerHTML = `<div class="field"><label class="label is-small">${col}</label><div class="select is-small is-fullwidth"><select data-col="${col}" id="filter_${colId}"><option value="">All</option><option>Progressive</option><option>Preview</option></select></div></div>`;
    } else if (col === 'Abandoned') {
      wrapper.innerHTML = `<div class="field"><label class="label is-small">${col}</label><div class="select is-small is-fullwidth"><select data-col="${col}" id="filter_${colId}"><option value="">All</option><option>Yes</option><option>No</option></select></div></div>`;
    } else {
      wrapper.innerHTML = `<div class="field"><label class="label is-small">${col}</label><input data-col="${col}" id="filter_${colId}" class="input is-small" type="text" placeholder="Search ${col}"></div>`;
    }
    grid.appendChild(wrapper);
  });
  // Attach listeners
  grid.querySelectorAll('[data-col]').forEach(el => {
    const ev = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(ev, applyFilters);
  });

  // Filters are already visible by default now
}

function applyFilters() {
  const grid = document.getElementById('filtersGrid');
  if (!grid) return;
  const filters = {};
  grid.querySelectorAll('[data-col]').forEach(el => {
    const val = el.value.trim().toLowerCase();
    if (val) filters[el.dataset.col] = val;
  });
  if (!Object.keys(filters).length) {
    currentFiltered = [...lastRecords];
    renderReportTable(currentFiltered);
    if (statsBox) {
      statsBox.innerHTML = `<strong>${currentFiltered.length}</strong> records fetched`;
      show(statsBox);
    }
    return;
  }
  const normalize = s => s.toLowerCase().replace(/[^0-9a-z]/g, '');
  const toDisplay = v => {
    if (v == null) return '';
    // Numeric epoch seconds or milliseconds
    if (typeof v === 'number') {
      const ms = v > 10_000_000_000 ? v : v * 1000;
      return isoToLocal(new Date(ms).toISOString());
    }
    // Pure digits string (epoch)
    if (typeof v === 'string' && /^\d+$/.test(v)) {
      const num = Number(v);
      if (!Number.isNaN(num) && num > 1_000_000_000) {
        const ms = v.length > 10 ? num : num * 1000;
        return isoToLocal(new Date(ms).toISOString());
      }
    }
    // ISO string with T
    if (typeof v === 'string' && /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/.test(v)) {
      return isoToLocal(v);
    }
    return String(v);
  };
  currentFiltered = lastRecords.filter(rec => {
    return Object.entries(filters).every(([col, term]) => {
      const cellVal = toDisplay(rec[col]);
      return normalize(cellVal).includes(normalize(term));
    });
  });
  renderReportTable(currentFiltered);
  if (statsBox) {
    statsBox.innerHTML = `<strong>${currentFiltered.length}</strong> records fetched`;
    show(statsBox);
  }
}

// Enable fetch button only when both start & end date-times are selected
function toggleFetchBtn() {
  const startVal = document.getElementById('start').value;
  const endVal   = document.getElementById('end').value;
  fetchBtn.disabled = !(startVal && endVal);
}

document.getElementById('start').addEventListener('change', toggleFetchBtn);
document.getElementById('end').addEventListener('change', toggleFetchBtn);
toggleFetchBtn(); // run once on load

form.addEventListener('submit', async e => {
  e.preventDefault();
  hide(errorBox);
  show(loadingEl);
  table.innerHTML = '';
  hide(statsBox);
  csvBtn.disabled = true;

  const account = document.getElementById('account').value.trim();
  // Cache globally for renderReportTable to use when constructing /api/recordings URLs
  tenantAccount = account;
  const start = inputToDubaiIso(document.getElementById('start').value);
  const end = inputToDubaiIso(document.getElementById('end').value);

  try {
    const params = { account, start, end };
    // Fetch queue (inbound/outbound) and Campaign Activity in parallel
    const [inRes, outRes, campRes] = await Promise.all([
      axios.get('/api/reports/queueCalls', { params }),
      axios.get('/api/reports/queueOutboundCalls', { params }),
      axios.get('/api/reports/campaignsActivity', { params })
    ]);

    const inboundRows = (inRes.data.data || []).map(r => normalizeRow(r, 'in'));
    const outboundRows = (outRes.data.data || []).map(r => normalizeRow(r, 'out'));
    const campaignRows = (campRes.data.data || []).map(r => normalizeRow(r, 'camp'));

    // Helper to derive comparable timestamp for sorting
    const toEpoch = rec => {
      const v = rec['Called Time'];
      if (v) return typeof v === 'number' ? v : Date.parse(v);
      return 0;
    };

    // Merge all rows and sort descending by timestamp
    const allRows = [...inboundRows, ...outboundRows, ...campaignRows].sort((a, b) => toEpoch(b) - toEpoch(a));

    lastRecords = allRows;
    // Make sure filters exist then apply current values
    buildFilters(); // safe no-op if already built
    applyFilters();

    csvBtn.disabled = false;
    // If no filters were supplied (all filter inputs empty), show inbound/outbound/campaign totals.
    const anyFilter = Array.from(document.querySelectorAll('#filtersGrid [data-col]'))
      .some(el => el.value.trim() !== '');
    if (!anyFilter) {
      statsBox.innerHTML = `Inbound: <strong>${inboundRows.length}</strong> &nbsp;|&nbsp; Outbound: <strong>${outboundRows.length}</strong> &nbsp;|&nbsp; Campaign: <strong>${campaignRows.length}</strong> &nbsp;|&nbsp; Total: <strong>${allRows.length}</strong>`;
      show(statsBox);
    }
  } catch (err) {
    // Extract meaningful message from server or axios error.
    const respErr = err.response?.data?.error;
    let msg = err.message;
    if (typeof respErr === 'string') {
      msg = respErr;
    } else if (respErr && typeof respErr === 'object') {
      msg = respErr.message || JSON.stringify(respErr);
    } else if (err.response?.data && typeof err.response.data === 'string') {
      msg = err.response.data;
    }
    errorBox.textContent = msg;
    show(errorBox);
  } finally {
    hide(loadingEl);
  }
});

// Convert current records to CSV and trigger download
function recordsToCsv(recs) {
  if (!recs.length) return '';
  const header = HEADERS.join(',');
  const rows = recs.map(r => HEADERS.map(h => {
    let v = r[h] ?? '';
    // Exclude history columns that hold HTML
    if (h === 'Agent History' || h === 'Queue History' || h === 'Lead History') {
      v = '';
    }
    if (typeof v === 'object') v = JSON.stringify(v);
    // Escape double quotes and wrap if value contains comma/newline
    const s = String(v).replace(/"/g, '""');
    return s.includes(',') || s.includes('\n') ? `"${s}"` : s;
  }).join(','));
  return [header, ...rows].join('\n');
}

csvBtn.addEventListener('click', () => {
  const list = (currentFiltered && currentFiltered.length) ? currentFiltered : lastRecords;
  const csv = recordsToCsv(list);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `queue_report_${Date.now()}.csv`;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

// Build filters immediately on page load so they are visible by default
buildFilters();