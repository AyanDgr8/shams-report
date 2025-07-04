// agentStatus.js
// Fetch Agents Status & Activity report for a tenant and output to
// stdout (table) or write to a file (CSV or JSON).
//
// Usage examples:
//   node -r dotenv/config agentStatus.js mc_int 2025-07-02T08:00:00Z 2025-07-02T12:00:00Z
//   node -r dotenv/config agentStatus.js mc_int 2025-07-02T08:00:00Z 2025-07-02T12:00:00Z report.csv
//
// The script automatically handles pagination, retries (exp backoff),
// and self-signed certificates (inherits httpsAgent from tokenService).

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { getPortalToken, httpsAgent } from './tokenService.js';

const MAX_RETRIES = 3;

/**
 * Convert an array of plain objects to a CSV string.
 * Very small helper to avoid a new dependency.
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
          ? `"${str.replace(/"/g, '""')}"` // escape quotes per RFC4180
          : str;
      })
      .join(delimiter)
  );
  return [header, ...rows].join('\n');
}

/**
 * Fetch the report, automatically traversing pages until completion.
 * @param {string} acct                         – tenant / account id.
 * @param {object} opts                         – query options.
 * @param {number} opts.startDate               – unix ms start of range.
 * @param {number} opts.endDate                 – unix ms end of range.
 * @param {string} [opts.name]                  – filter by agent name.
 * @param {string} [opts.extension]             – filter by extension.
 * @returns {Promise<object[]>}                 – concatenated rows.
 */
export async function fetchAgentStatus(
  acct,
  { startDate, endDate, name, extension } = {}
) {
  // Use env-configurable endpoint; fall back to the common REST path.
  const url = `${process.env.BASE_URL}${process.env.AGENT_STATUS_ENDPOINT || '/api/v2/reports/callcenter/agents/stats'}`;
  const records = [];
  let startKey;

  retry: for (let attempt = 0, delay = 1_000; attempt < MAX_RETRIES; attempt++, delay *= 2) {
    try {
      while (true) {
        const params = {
          startDate: Math.floor(startDate / 1000),
          endDate: Math.floor(endDate / 1000),
          ...(name && { name }),
          ...(extension && { extension }),
          ...(startKey && { start_key: startKey })
        };

        // Obtain JWT once and log the first 40 chars for debugging
        const token = await getPortalToken(acct);
        console.log('REQ', url, params, {
          'X-Account-ID': process.env.ACCOUNT_ID_HEADER ?? acct,
          'X-User-Agent': 'portal',
          Authorization: `Bearer ${token ? token.slice(0,40) + '…' : 'undefined'}`
        });

        const { data } = await axios.get(url, {
          params,
          headers: {
            'X-Account-ID': process.env.ACCOUNT_ID_HEADER ?? acct,
            'X-User-Agent': 'portal',
            Authorization: `Bearer ${token}`
          },
          httpsAgent
        });

        let chunk;
        const ensureExt = r => ({
          extension: r.extension ?? r.ext ?? r.userId ?? r.user_id ?? r.id ?? '',
          ...r
        });

        if (Array.isArray(data.data)) {
          chunk = data.data.map(ensureExt);
        } else if (data && typeof data === 'object') {
          // Newer portal returns an object keyed by extension/userId
          // Preserve the key (extension) by merging it into each record
          chunk = Object.entries(data).map(([ext, info]) => ensureExt({ extension: ext, ...info }));
        } else {
          console.error('Unexpected API payload; dumping full response:', JSON.stringify(data, null, 2));
          throw new Error('Unrecognised API response format');
        }
        records.push(...chunk);
        if (!data.next_start_key) break;
        startKey = data.next_start_key; // continue to next page
      }
      break retry; // success
    } catch (err) {
      if (attempt === MAX_RETRIES - 1) throw err;
      console.warn(`Request failed (${err.message}); retrying in ${delay}ms…`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  return records;
}

async function cli() {
  const [,, acct, startIso, endIso, outputFile] = process.argv;
  if (!acct || !startIso || !endIso) {
    console.error(`Usage: node -r dotenv/config agentStatus.js <accountId> <startISO> <endISO> [outputFile.{csv|json}]`);
    process.exit(1);
  }

  const startDate = Date.parse(startIso);
  const endDate   = Date.parse(endIso);
  if (Number.isNaN(startDate) || Number.isNaN(endDate)) {
    console.error('Invalid ISO date/time strings.');
    process.exit(1);
  }

  const data = await fetchAgentStatus(acct, { startDate, endDate });

  if (outputFile) {
    await fs.promises.mkdir(path.dirname(outputFile), { recursive: true });
    if (outputFile.endsWith('.csv')) {
      await fs.promises.writeFile(outputFile, toCsv(data));
    } else {
      await fs.promises.writeFile(outputFile, JSON.stringify(data, null, 2));
    }
    console.log(`Saved ${data.length} records to ${outputFile}`);
  } else {
    console.table(data);
  }
}

// Execute when run directly
if (import.meta.url === process.argv[1] || import.meta.url === `file://${process.argv[1]}`) {
  cli().catch(err => {
    console.error(err.response?.data || err.stack || err.message);
    process.exit(1);
  });
}
