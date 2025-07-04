// tokenService.js
import axios from 'axios';
import ms from 'ms';
import https from 'https';

const cache = new Map();        // In prod use Redis
const MAX_RETRIES = 3;

// Optional: accept self-signed certificates in dev; set NODE_TLS_REJECT_UNAUTHORIZED=1 in prod
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// Cache structure: Map<tenant, {access, refresh, expiresAt}>

/**
 * Fetch an access token using the legacy call center login endpoint.
 * Falls back to the cached token until two minutes before expiry.
 *
 * @param {string} tenant - tenant / domain, e.g. `mc_int`.
 * @returns {Promise<string>} access token (JWT)
 */
export async function getToken(tenant) {
  const now = Date.now();
  const cached = cache.get(tenant);
  if (cached && now < cached.expiresAt - ms('2m')) return cached.access;

  for (let i = 0, delay = 1000; i < MAX_RETRIES; i++, delay *= 2) {
    try {
      const {data} = await axios.post(
        `${process.env.BASE_URL}/portal/callcenter/reports/agents-status-activity`,
        { username: process.env.API_USERNAME, password: process.env.API_PASSWORD, domain: tenant },
        { timeout: 5000, httpsAgent, headers: { Accept: 'application/json' } }   // ensure JSON
      );
      cache.set(tenant, {
        access: data.access_token,
        refresh: data.refresh_token,
        expiresAt: now + ms('1h')   // adjust to real TTL
      });
      return data.access_token;
    } catch (err) {
      if (i === MAX_RETRIES - 1) throw err;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

/**
 * Fetch an access token using the modern portal login endpoint that the web
 * UI employs. This token is accepted by the new `/api/v2/reports/...` routes.
 * Falls back to the cached token until two minutes before expiry.
 *
 * @param {string} tenant - tenant / domain, e.g. `mc_int`.
 * @returns {Promise<string>} access token (JWT)
 */
export async function getPortalToken(tenant) {
  const now = Date.now();
  const cached = cache.get(`portal:${tenant}`);
  if (cached && now < cached.expiresAt - ms('2m')) return cached.access;

  // Back-off loop across candidate endpoints / payloads
  const base = process.env.BASE_URL;
  const candidates = [
    // OAuth login path used by the portal UI (works on modern installs)
    { url: `${base}/api/v2/config/login/oauth`, body: { domain: tenant, username: process.env.API_USERNAME, password: process.env.API_PASSWORD } },
    // v2 login using domain (fallback for older back-ends)
    { url: `${base}/api/v2/login`, body: { domain: tenant, username: process.env.API_USERNAME, password: process.env.API_PASSWORD } },
    // very old legacy login path
    { url: `${base}/api/login`, body: { domain: tenant, username: process.env.API_USERNAME, password: process.env.API_PASSWORD } },
  ];

  for (const { url, body } of candidates) {
    for (let attempt = 0, delay = 1000; attempt < MAX_RETRIES; attempt++, delay *= 2) {
      try {
        const { data } = await axios.post(url, body, {
          timeout: 5000,
          httpsAgent,
          headers: { Accept: 'application/json' }
        });

        const access = data.accessToken || data.access_token;
        if (!access) throw new Error('No access token in response');

        const refresh = data.refreshToken || data.refresh_token;
        const expiresAt = data.expiresIn ? Date.now() + data.expiresIn * 1000 : Date.now() + ms('1h');

        cache.set(`portal:${tenant}`, { access, refresh, expiresAt });
        console.log(`✅ Portal login succeeded at ${url}`);
        return access;
      } catch (err) {
        if (attempt === MAX_RETRIES - 1) {
          // try next candidate endpoint
          if (process.env.DEBUG) {
            console.warn(`Login failed at ${url}: ${err.response?.status || err.message}`);
          }
        } else {
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
  }
  throw new Error('All portal login attempts failed – check credentials/endpoints');
}

export { httpsAgent };