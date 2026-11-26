'use strict';

const express = require('express');
const pino = require('pino');
const { createLogger } = require('../shared/logger');
const { requestIdMiddleware } = require('../shared/requestIdMiddleware');

const SERVICE = 'mock-jira';
const PORT = Number(process.env.PORT || 8004);
const STATUSES = ['Open', 'Resolved'];
const RCA_SOURCES = ['bits_ai', 'datadog_datastore_cache'];

const logger = createLogger(pino, SERVICE);
const app = express();
app.use(express.json());
app.use(requestIdMiddleware({ tracer: null, logger, dependency: 'none' }));

// In-memory only. Newest first, so GET returns the array as is.
let tickets = [];
let nextNumber = 1;

function badRequest(res, message) {
  res.locals.error_code = 'INVALID_TICKET_REQUEST';
  res.status(400).json({ error_code: 'INVALID_TICKET_REQUEST', message });
}

app.get('/tickets', (req, res) => res.json(tickets));

// A POST whose fingerprint matches an Open ticket is a duplicate: it bumps that ticket's
// duplicate_count instead of opening a second one. A Resolved ticket never absorbs a new outage.
app.post('/tickets', (req, res) => {
  const { fingerprint, title, rca_source, rca_summary = '', status = 'Open' } = req.body || {};
  if (typeof fingerprint !== 'string' || !fingerprint) return badRequest(res, 'fingerprint is required');
  if (typeof title !== 'string' || !title) return badRequest(res, 'title is required');
  if (!RCA_SOURCES.includes(rca_source)) return badRequest(res, `rca_source must be one of ${RCA_SOURCES.join(', ')}`);
  if (!STATUSES.includes(status)) return badRequest(res, `status must be one of ${STATUSES.join(', ')}`);

  const open = tickets.find((t) => t.fingerprint === fingerprint && t.status === 'Open');
  if (open) {
    open.duplicate_count += 1;
    return res.status(200).json(open);
  }

  const now = new Date().toISOString();
  const ticket = {
    id: `GCC-${nextNumber++}`,
    fingerprint,
    title,
    status,
    rca_source,
    rca_summary: String(rca_summary),
    duplicate_count: 0,
    resolution_notes: [],
    created_at: now,
    resolved_at: status === 'Resolved' ? now : null,
  };
  tickets.unshift(ticket);
  req.log.info({ msg: 'ticket_created', ticket_id: ticket.id, fingerprint, rca_source });
  res.status(201).json(ticket);
});

// Body: { status?: "Open" | "Resolved", increment_duplicate?: true, resolution_note?: string }
app.patch('/tickets/:id', (req, res) => {
  const ticket = tickets.find((t) => t.id === req.params.id);
  if (!ticket) {
    res.locals.error_code = 'TICKET_NOT_FOUND';
    return res.status(404).json({ error_code: 'TICKET_NOT_FOUND' });
  }
  const { status, increment_duplicate, resolution_note } = req.body || {};
  if (status !== undefined && !STATUSES.includes(status)) {
    return badRequest(res, `status must be one of ${STATUSES.join(', ')}`);
  }
  if (resolution_note !== undefined && typeof resolution_note !== 'string') {
    return badRequest(res, 'resolution_note must be a string');
  }

  if (status && status !== ticket.status) {
    ticket.status = status;
    ticket.resolved_at = status === 'Resolved' ? new Date().toISOString() : null;
  }
  if (increment_duplicate === true) ticket.duplicate_count += 1;
  if (resolution_note) ticket.resolution_notes.push(resolution_note);
  res.json(ticket);
});

app.delete('/tickets', (req, res) => {
  const cleared = tickets.length;
  tickets = [];
  nextNumber = 1;
  res.json({ status: 'cleared', cleared });
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: SERVICE }));

app.listen(PORT, () => logger.info({ msg: 'listening', port: PORT }));
