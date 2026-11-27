'use strict';
// Every column in server/db.js that points at a job, lead or client, and
// whether a merge moves it. services/client-merge.js consumes PLAIN.clients
// and POLYMORPHIC; test/record-references.test.js pins the lists to the
// schema, so a new reference in db.js fails until it is registered here.

// Tables whose rows name a record by (entity_type, entity_id). Moved for every kind.
const POLYMORPHIC = ['attachments', 'tasks', 'reminders', 'calendar_events', 'compliance_items', 'receipts',
  'inbound_emails', 'plans', 'report_shares', 'job_reports', 'ai_sessions'];

// Plain id columns, per kind. { table, col }.
const PLAIN = {
  jobs: [
    { table: 'job_change_orders', col: 'job_id' }, { table: 'job_purchase_orders', col: 'job_id' },
    { table: 'job_vendor_bills', col: 'job_id' }, { table: 'job_workflow_items', col: 'job_id' },
    { table: 'pay_applications', col: 'job_id' }, { table: 'qb_cost_lines', col: 'job_id' },
    { table: 'schedule_entries', col: 'job_id' }, { table: 'job_reports', col: 'job_id' },
    { table: 'invoices', col: 'job_id' }, { table: 'projects', col: 'job_id' },
    { table: 'service_tickets', col: 'job_id' }, { table: 'leads', col: 'job_id' },
  ],
  leads: [
    { table: 'jobs', col: 'lead_id' }, { table: 'projects', col: 'lead_id' }, { table: 'service_tickets', col: 'lead_id' },
  ],
  clients: [
    { table: 'leads', col: 'client_id' }, { table: 'jobs', col: 'client_id' }, { table: 'clients', col: 'parent_client_id' },
    { table: 'invoices', col: 'client_id' }, { table: 'payments', col: 'client_id' }, { table: 'projects', col: 'client_id' },
    { table: 'service_tickets', col: 'client_id' },
  ],
};

// Columns that reference a record but deliberately are NOT moved, with why. The
// registry test fails when db.js grows a reference that is in neither list.
const NOT_MOVED = {
  'job_access.job_id': 'moved with conflict handling (moveUnique)',
  'job_subs.job_id': 'moved with conflict handling (moveUnique)',
  'production_checklist_rows.job_id': 'moved with conflict handling (moveUnique) — one row per job per checklist, so a row only crosses when the survivor is not already on that sheet',
  'node_graphs.job_id': 'one per job: moved only when the survivor has none',
  'lead_graphs.lead_id': 'one per lead: moved only when the survivor has none',
  'file_folders.entity_id': 'folded into same-named survivor folders (moveFolders)',
  'attachment_folder_grants.entity_id': 'moved with conflict handling (moveUnique)',
  'live_rooms.entity_id': 'one live room per record: moved only when the survivor has none',
  'ai_messages.entity_type': 'chat history rows carry no entity id to move',
  'org_folder_templates.entity_type': 'a template, not a reference to a record',
  'jobs.bt_job_id': 'the Buildertrend link itself',
  'leads.bt_lead_id': 'the Buildertrend link itself',
  'estimates.data': 'blob references moved in JS (lead_id, clientId)',
};

module.exports = { POLYMORPHIC, PLAIN, NOT_MOVED };
