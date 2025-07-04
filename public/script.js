// script.js

/* global axios */
const form = document.getElementById('filterForm');
const loadingEl = document.getElementById('loading');
const errorBox = document.getElementById('errorBox');
const table = document.getElementById('resultTable');
const statsBox = document.getElementById('stats');
const csvBtn = document.getElementById('csvBtn');

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
  'callee id number'
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
  'Call ID',
  'Queue name',
  'Called Time',
  'Caller Id Number',
  'Caller Id Name',
  'Answered time',
  'Hangup time',
  'Wait Duration',
  'Talk Duration',
  'Queue History',
  'Agent History',
  'Agent Disposition',
  'Callee ID number'
];

HEADERS.forEach(h => {
  const l = h.toLowerCase();
  if (l.includes('number') || l.includes('name')) RAW_COLUMNS.add(l);
});

// Normalize inbound/outbound API rows to the unified schema expected by HEADERS
function normalizeRow(row, source) {
  const isOutbound = source === 'out';
  return {
    'Call ID': row.call_id ?? row.callid ?? '',
    'Queue name': row.queue_name ?? '',
    'Called Time': row.called_time ?? '',
    'Caller Id Number': row.caller_id_number ?? '',
    'Caller Id Name': row.caller_id_name ?? '',
    'Answered time': row.answered_time ?? '',
    'Hangup time': row.hangup_time ?? '',
    'Wait Duration': row.wait_duration ?? '',
    'Talk Duration': row.talked_duration ?? '',
    'Callee ID number': isOutbound ? (row.to ?? '') : (row.callee_id_number ?? ''),
    'Agent Disposition': row.agent_disposition ?? '',
    'Queue History': row.queue_history ?? '',
    'Agent History': row.agent_history ?? ''
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
    return '<tr>' + HEADERS.map(h => {
      let v = rec[h];
      if (v == null) v = '';

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
}

let lastRecords = [];

form.addEventListener('submit', async e => {
  e.preventDefault();
  hide(errorBox);
  show(loadingEl);
  table.innerHTML = '';
  hide(statsBox);
  csvBtn.disabled = true;

  const account = document.getElementById('account').value.trim();
  const start = inputToDubaiIso(document.getElementById('start').value);
  const end = inputToDubaiIso(document.getElementById('end').value);

  try {
    const params = { account, start, end };
    // Fetch inbound and outbound queue calls in parallel
    const [inRes, outRes] = await Promise.all([
      axios.get('/api/reports/queueCalls', { params }),
      axios.get('/api/reports/queueOutboundCalls', { params })
    ]);

    const inboundRows = (inRes.data.data || []).map(r => normalizeRow(r, 'in'));
    const outboundRows = (outRes.data.data || []).map(r => normalizeRow(r, 'out'));

    // Merge and sort descending by Called Time (epoch seconds or ISO)
    const allRows = [...inboundRows, ...outboundRows].sort((a, b) => {
      const va = a['Called Time'];
      const vb = b['Called Time'];
      const tA = typeof va === 'number' ? va : Date.parse(va);
      const tB = typeof vb === 'number' ? vb : Date.parse(vb);
      return tB - tA; // DESC
    });

    renderReportTable(allRows);
    lastRecords = allRows;
    csvBtn.disabled = false;
    statsBox.textContent = `Fetched ${allRows.length} records`;
    show(statsBox);
  } catch (err) {
    errorBox.textContent = err.response?.data?.error || err.message;
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
    if (typeof v === 'object') v = JSON.stringify(v);
    const s = String(v).replace(/"/g, '""');
    return s.includes(',') || s.includes('\n') ? `"${s}"` : s;
  }).join(','));
  return [header, ...rows].join('\n');
}

csvBtn.addEventListener('click', () => {
  const csv = recordsToCsv(lastRecords);
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