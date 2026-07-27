const db = require('./db');

// Records one entry in the activity log. `snapshot` should be the full data
// object at the time of the action — critical for 'delete' actions, since
// it's the only way to recover what was lost if something was removed by
// mistake. Never throws — logging failures shouldn't ever block the actual
// operation they're describing.
function logActivity({ action, entityType, entityId, summary, snapshot, userName }) {
  try {
    db.prepare(`
      INSERT INTO activity_log (action, entity_type, entity_id, summary, snapshot, user_name)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      action,
      entityType,
      entityId != null ? Number(entityId) : null,
      summary || null,
      snapshot !== undefined ? JSON.stringify(snapshot) : null,
      userName || null
    );
  } catch (err) {
    console.error('Failed to write activity log entry (continuing anyway):', err);
  }
}

module.exports = { logActivity };
