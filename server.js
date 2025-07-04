// server.js

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
// import { fetchAgentStatus } from './agentStatus.js';
import { fetchReport } from './reportFetcher.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5555;
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

app.listen(PORT, HOST, () => {
  console.log(`Web app running at ${PUBLIC_URL}`);
});
