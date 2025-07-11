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
import ms from 'ms';

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

// Simple in-memory cache (per Node process). In production replace with Redis.
const CACHE_TTL = ms('5m');          // 5 minutes
const reportCache = new Map();       // Map<cacheKey,{expires:number,data:object[]}>

// Generate a unique key from report + tenant + window params.
function makeCacheKey(report, tenant, params) {
  const { startDate = '', endDate = '' } = params || {};
  return `${report}|${tenant}|${startDate}|${endDate}`;
}

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

  // ---------------- Cache lookup ----------------
  const cacheKey = makeCacheKey(report, tenant, params);
  const cached = reportCache.get(cacheKey);
  if (cached && Date.now() < cached.expires) {
    // Return a shallow copy so callers can mutate safely
    return Array.isArray(cached.data) ? [...cached.data] : cached.data;
  }
  // ------------------------------------------------

  const url = `${process.env.BASE_URL}${ENDPOINTS[report]}`;
  let token;
  const out = [];
  let startKey;
  let nextStartKey = null;
  const maxRows = params.maxRows;

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
              'agent_subdisposition'
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
              'agent_subdisposition'
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
              'agent_subdisposition',
              'answered_time'
            ].join(',')
          }),
          ...(startKey && { start_key: startKey })
        };

        // Acquire/refresh token for every loop iteration (cheap due to cache)
        token = await getPortalToken(tenant);

        const resp = await axios.get(url, {
          params: qs,
          headers: {
            Authorization: `Bearer ${token}`,
            'X-User-Agent': 'portal',
            'X-Account-ID': process.env.ACCOUNT_ID_HEADER ?? tenant
          },
          httpsAgent
        });

        const payload = resp.data;

        // Always capture paging token; undefined → null to signal end of list
        nextStartKey = payload.next_start_key ?? null;

        let records;
        if (Array.isArray(payload?.data)) {
          records = payload.data;
        } else if (Array.isArray(payload)) {
          // Some endpoints return an array at top-level
          records = payload;
        } else if (payload.rows && Array.isArray(payload.rows)) {
          records = payload.rows;
        } else {
          // fallback – attempt to flatten object of objects (similar to agentStatus)
          records = Object.entries(payload).map(([k, v]) => ({ key: k, ...v }));
        }

        const remaining = maxRows ? (maxRows - out.length) : records.length;

        // Push at most `remaining` records so we never exceed requested limit
        if (remaining > 0) {
          out.push(...records.slice(0, remaining));
        }

        // NEW: break early once we have *some* rows so caller can respond
        // quickly. We keep nextStartKey so the very next request can resume
        // where we left off.
        if (out.length > 0) {
          break;
        }

        // If we still didn't accumulate anything and there is another page,
        // continue looping; otherwise exit.
        if (nextStartKey === null) {
          break;
        }

        startKey = nextStartKey;
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

    // Cache result BEFORE returning
    reportCache.set(cacheKey, { expires: Date.now() + CACHE_TTL, data: firstRows });
    return { rows: firstRows, next: nextStartKey };
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
    // Cache result BEFORE returning
    reportCache.set(cacheKey, { expires: Date.now() + CACHE_TTL, data: out });
    return { rows: out, next: nextStartKey };
  }

  // Cache result BEFORE returning
  reportCache.set(cacheKey, { expires: Date.now() + CACHE_TTL, data: out });
  return { rows: out, next: nextStartKey };
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
  console.log(`Fetched ${data.rows.length} rows for ${report}`);

  if (outFile) {
    await fs.promises.mkdir(path.dirname(outFile), { recursive: true });
    if (outFile.endsWith('.csv')) {
      await fs.promises.writeFile(outFile, toCsv(data.rows));
    } else {
      await fs.promises.writeFile(outFile, JSON.stringify(data.rows, null, 2));
    }
    console.log(`Saved to ${outFile}`);
  } else {
    console.table(data.rows);
  }
}

if (import.meta.url === process.argv[1] || import.meta.url === `file://${process.argv[1]}`) {
  cli().catch(err => {
    console.error(err.response?.data || err.stack || err.message);
    process.exit(1);
  });
}
