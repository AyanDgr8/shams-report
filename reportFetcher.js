// reportFetcher.js
// Generic report fetcher for call-center portal tables.
// Supports the following endpoints:
//   – /portal/reports/cdrs                         (CDRs)
//   – /portal/callcenter/reports/queues-calls      (Queue Calls)
//   – /portal/callcenter/reports/queues-outbound-calls (Queue Outbound Calls)
//   – /portal/callcenter/reports/campaigns-activity    (Campaigns Activity)
//
// Like agentStatus.js this module handles:
//   • Portal authentication via tokenService.getPortalToken
//   – Automatic pagination via next_start_key when provided
//   • Exponential-backoff retry logic (up to 3 attempts)
//   • Optional CSV serialization helper
//   • A minimal CLI for ad-hoc usage

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { getPortalToken, httpsAgent } from './tokenService.js';

const MAX_RETRIES = 3;

const ENDPOINTS = {
  // Raw CDRs
  cdrs: '/api/v2/reports/cdrs',

  // Queue-specific CDR summaries
  queueCalls: '/api/v2/reports/queues_cdrs',                 // inbound queues
  queueOutboundCalls: '/api/v2/reports/queues_outbound_cdrs', // outbound queues

  // Campaign dialer lead activity
  campaignsActivity: '/api/v2/reports/campaigns/leads/history'
};

/**
 * Convert an array of plain objects to a CSV string.
 * Borrowed from agentStatus.js to avoid new deps.
 */
function toCsv(records, delimiter = ',') {
  if (!records.length) return '';
  const header = Object.keys(records[0]).join(delimiter);
  const rows = records.map(r =>
    Object.values(r)
      .map(v => {
        if (v == null) return '';
        const str = String(v);
        return str.includes(delimiter) || str.includes('\n') || str.includes('"')
          ? `"${str.replace(/"/g, '""')}"` // RFC4180 escaping
          : str;
      })
      .join(delimiter)
  );
  return [header, ...rows].join('\n');
}

/**
 * Generic report fetcher with pagination + retries.
 *
 * @param {string} report   – one of keys in ENDPOINTS.
 * @param {string} tenant   – domain / account id.
 * @param {object} params   – query params (startDate/endDate etc).
 * @returns {Promise<object[]>}
 */
export async function fetchReport(report, tenant, params = {}) {
  if (!ENDPOINTS[report]) throw new Error(`Unknown report type: ${report}`);

  const url = `${process.env.BASE_URL}${ENDPOINTS[report]}`;
  let token;
  const out = [];
  let startKey;

  retry: for (let attempt = 0, delay = 1_000; attempt < MAX_RETRIES; attempt++, delay *= 2) {
    try {
      while (true) {
        const qs = {
          ...params,
          // Request full set of columns for queue reports so duration, abandon etc. are returned
          ...(report === 'queueOutboundCalls' && {
            fields: [
              'called_time',
              'agent_name',
              'agent_ext',
              'destination',
              'answered_time',
              'hangup_time',
              'wait_duration',
              'talked_duration',
              'queue_name',
              'queue_history',
              'agent_history',
              'agent_hangup',
              'call_id',
              'bleg_call_id',
              'event_timestamp',
              'agent_first_name',
              'agent_last_name',
              'agent_extension',
              'agent_email',
              'agent_talk_time',
              'agent_connect_time',
              'agent_action',
              'agent_transfer',
              'csat',
              'media_recording_id',
              'recording_filename',
              'caller_id_name',
              'caller_id_number',
              'a_leg',
              'to',
              'interaction_id',
              'agent_disposition',
              'agent_subdisposition1',
              'agent_subdisposition2'
            ].join(',')
          }),
          // Same for inbound queue calls (queues_cdrs) so we get talked_duration & abandoned columns
          ...(report === 'queueCalls' && {
            fields: [
              'called_time',
              'caller_id_number',
              'caller_id_name',
              'answered_time',
              'hangup_time',
              'wait_duration',
              'talked_duration',
              'queue_name',
              'abandoned',
              'queue_history',
              'agent_history',
              'agent_attempts',
              'agent_hangup',
              'call_id',
              'bleg_call_id',
              'event_timestamp',
              'agent_first_name',
              'agent_last_name',
              'agent_extension',
              'agent_email',
              'agent_talk_time',
              'agent_connect_time',
              'agent_action',
              'agent_transfer',
              'csat',
              'media_recording_id',
              'recording_filename',
              'callee_id_number',
              'a_leg',
              'interaction_id',
              'agent_disposition',
              'agent_subdisposition1',
              'agent_subdisposition2'
            ].join(',')
          }),
          // Request all relevant columns for campaign activity
          ...(report === 'campaignsActivity' && {
            fields: [
              'datetime',
              'timestamp',
              'campaign_name',
              'campaign_type',
              'lead_name',
              'lead_first_name',
              'lead_last_name',
              'lead_number',
              'lead_ticket_id',
              'lead_type',
              'agent_name',
              'agent_extension',
              'agent_talk_time',
              'lead_history',
              'call_id',
              'campaign_timestamps',
              'media_recording_id',
              'recording_filename',
              'status',
              'customer_wait_time_sla',
              'customer_wait_time_over_sla',
              'disposition',
              'hangup_cause',
              'lead_disposition',
              'answered_time'
            ].join(',')
          }),
          ...(startKey && { start_key: startKey })
        };

        // Acquire/refresh token for every loop iteration (cheap due to cache)
        token = await getPortalToken(tenant);

        const { data } = await axios.get(url, {
          params: qs,
          headers: {
            Authorization: `Bearer ${token}`,
            'X-User-Agent': 'portal',
            'X-Account-ID': process.env.ACCOUNT_ID_HEADER ?? tenant
          },
          httpsAgent
        });

        let chunk;
        if (Array.isArray(data.data)) {
          chunk = data.data;
        } else if (Array.isArray(data)) {
          // Some endpoints return an array at top-level
          chunk = data;
        } else if (data.rows && Array.isArray(data.rows)) {
          chunk = data.rows;
        } else {
          // fallback – attempt to flatten object of objects (similar to agentStatus)
          chunk = Object.entries(data).map(([k, v]) => ({ key: k, ...v }));
        }
        out.push(...chunk);

        if (data.next_start_key) {
          startKey = data.next_start_key;
        } else {
          break; // no more pages
        }
      }
      break retry; // success
    } catch (err) {
      if (attempt === MAX_RETRIES - 1) throw err;
      console.warn(`Report fetch failed (${err.message}); retrying in ${delay}ms…`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  // ---------------------------------------------------------------------------
  // Post-processing helpers
  if (report === 'queueCalls' || report === 'queueOutboundCalls') {
    // Derive durations if the backend omitted them (older Talkdesk tenants)
    out.forEach(record => {
      // Talked duration
      if (!record.talked_duration && record.hangup_time && record.answered_time) {
        record.talked_duration = record.hangup_time - record.answered_time;
      }
      // Wait / queue duration
      if (!record.wait_duration && record.called_time) {
        if (record.answered_time) {
          record.wait_duration = record.answered_time - record.called_time;
        } else if (record.hangup_time) {
          record.wait_duration = record.hangup_time - record.called_time;
        }
      }
    });
  }

  // For inbound queue reports Talkdesk returns one row per agent leg.
  // When the consumer only needs a single row per call we keep the *first*
  // occurrence for each call_id (usually the initial `dial` leg) and drop the rest.
  if (report === 'queueCalls') {
    const seen = new Set();
    const firstRows = [];
    for (const rec of out) {
      // If the row is missing a call_id we cannot group it – keep it.
      if (!rec.call_id) {
        firstRows.push(rec);
        continue;
      }
      if (!seen.has(rec.call_id)) {
        seen.add(rec.call_id);
        firstRows.push(rec);
      }
    }

    // Each first row may still contain a multi-entry agent_history array; keep only
    // its first element if so.
    firstRows.forEach(r => {
      if (Array.isArray(r.agent_history) && r.agent_history.length > 1) {
        r.agent_history = [r.agent_history[0]];
      }
    });

    return firstRows;
  }

  // For outbound queue reports the API returns one row but embeds full
  // queue history as an array.  Keep only the first queue_history element
  // (oldest) while leaving the full agent_history intact.
  if (report === 'queueOutboundCalls') {
    out.forEach(rec => {
      if (Array.isArray(rec.queue_history) && rec.queue_history.length > 1) {
        rec.queue_history = [rec.queue_history[0]];
      }
    });
    return out;
  }

  return out;
}

// Convenience wrappers
export const fetchCdrs = (tenant, opts) => fetchReport('cdrs', tenant, opts);
export const fetchQueueCalls = (tenant, opts) => fetchReport('queueCalls', tenant, opts);
export const fetchQueueOutboundCalls = (tenant, opts) => fetchReport('queueOutboundCalls', tenant, opts);
export const fetchCampaignsActivity = (tenant, opts) => fetchReport('campaignsActivity', tenant, opts);

/**
 * Minimal CLI: node -r dotenv/config reportFetcher.js <report> <tenant> <startISO> <endISO> [outfile]
 */
async function cli() {
  const [,, report, tenant, startIso, endIso, outFile] = process.argv;
  if (!report || !tenant) {
    console.error('Usage: node -r dotenv/config reportFetcher.js <report> <tenant> [startISO] [endISO] [outfile.{csv|json}]');
    console.error(`report = ${Object.keys(ENDPOINTS).join(' | ')}`);
    process.exit(1);
  }
  const params = {};
  if (startIso) {
    const startDate = Date.parse(startIso);
    if (Number.isNaN(startDate)) throw new Error('Invalid start date');
    params.startDate = Math.floor(startDate / 1000);
  }
  if (endIso) {
    const endDate = Date.parse(endIso);
    if (Number.isNaN(endDate)) throw new Error('Invalid end date');
    params.endDate = Math.floor(endDate / 1000);
  }

  const data = await fetchReport(report, tenant, params);
  console.log(`Fetched ${data.length} rows for ${report}`);

  if (outFile) {
    await fs.promises.mkdir(path.dirname(outFile), { recursive: true });
    if (outFile.endsWith('.csv')) {
      await fs.promises.writeFile(outFile, toCsv(data));
    } else {
      await fs.promises.writeFile(outFile, JSON.stringify(data, null, 2));
    }
    console.log(`Saved to ${outFile}`);
  } else {
    console.table(data);
  }
}

if (import.meta.url === process.argv[1] || import.meta.url === `file://${process.argv[1]}`) {
  cli().catch(err => {
    console.error(err.response?.data || err.stack || err.message);
    process.exit(1);
  });
}
