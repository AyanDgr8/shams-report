// server.js

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
// import { fetchAgentStatus } from './agentStatus.js';
import { fetchReport } from './reportFetcher.js';
import { getPortalToken, httpsAgent } from './tokenService.js';
import axios from 'axios';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 9595;
const HOST = process.env.HOST || '0.0.0.0'; // 0.0.0.0 ensures the server binds to all network interfaces
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

// Helper to resolve __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, 'public')));

// GET /api/reports/:type?account=<tenant>&start=<ISO>&end=<ISO>
app.get('/api/reports/:type', async (req, res) => {
  const { type } = req.params;
  const { account, start, end } = req.query;

  if (!account) {
    return res.status(400).json({ error: 'Missing account query param' });
  }

  const params = {};
  if (start) {
    const startDate = Date.parse(start);
    if (Number.isNaN(startDate)) {
      return res.status(400).json({ error: 'Invalid start date' });
    }
    params.startDate = Math.floor(startDate / 1000);
  }
  if (end) {
    const endDate = Date.parse(end);
    if (Number.isNaN(endDate)) {
      return res.status(400).json({ error: 'Invalid end date' });
    }
    params.endDate = Math.floor(endDate / 1000);
  }

  // Debug: log exactly what we are about to request
  console.log('fetchReport payload', {
    type,
    account,
    startDate: params.startDate,
    endDate: params.endDate
  });

  try {
    const data = await fetchReport(type, account, params);
    const processedData = data.map(row => {
      // Ensure agent_history is an array
      let history = row.agent_history;
      if (typeof history === 'string') {
        try { history = JSON.parse(history); } catch { history = []; }
      }

      let ts = row.answered_time;
      if (!ts && Array.isArray(history)) {
        const answerEvt = history.find(e => e.event === 'answer' || e.connected);
        if (answerEvt?.last_attempt) {
          const ms = answerEvt.last_attempt > 10_000_000_000 ? answerEvt.last_attempt : answerEvt.last_attempt * 1000;
          ts = new Date(ms).toISOString();
        }
      }
      return { ...row, answered_time: ts ?? '--' };
    });
    res.json({ data: processedData });
  } catch (err) {
    console.error(err.response?.data || err.stack || err.message);
    res.status(500).json({ error: err.message });
  }
});

// Proxy: GET /api/recordings/:id?account=<tenant>
// Streams the MP3 recording from the upstream UC backend while adding the required auth token.
app.get('/api/recordings/:id', async (req, res) => {
  const { id } = req.params;
  const { account } = req.query;

  if (!account) {
    return res.status(400).json({ error: 'Missing account query param' });
  }

  try {
    // Obtain (cached) JWT for this tenant
    const token = await getPortalToken(account);

    const upstreamUrl = `${process.env.BASE_URL}/api/v2/reports/recordings/${id}`;
    const upstreamRes = await axios.get(upstreamUrl, {
      responseType: 'stream',
      httpsAgent,
      headers: {
        Authorization: `Bearer ${token}`,
        'X-User-Agent': 'portal',
        'X-Account-ID': process.env.ACCOUNT_ID_HEADER ?? account
      }
    });

    // Propagate relevant headers so the browser can play the audio
    res.setHeader('Content-Type', upstreamRes.headers['content-type'] || 'audio/mpeg');
    if (upstreamRes.headers['content-disposition']) {
      res.setHeader('Content-Disposition', upstreamRes.headers['content-disposition']);
    }

    // Stream data
    upstreamRes.data.pipe(res);
  } catch (err) {
    console.error(err.response?.data || err.stack || err.message);
    const status = err.response?.status || 500;
    res.status(status).json({ error: err.message });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`Web app running at ${PUBLIC_URL}`);
});
