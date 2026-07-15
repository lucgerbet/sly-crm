import { Router } from 'express';
import db from '../db.js';

const router = Router();

// Public route — deliberately outside the app's Basic Auth (see the separate
// Traefik router in docker-compose.yml). The client id itself acts as the
// unguessable link token; this only ever turns email_opt_out ON, nothing else.
router.get('/:clientId', (req, res) => {
  const client = db.prepare('SELECT id, first_name FROM clients WHERE id = ?').get(req.params.clientId);
  if (!client) {
    return res.status(404).send('<html><body style="font-family:sans-serif;padding:40px;text-align:center"><p>Link not found.</p></body></html>');
  }
  db.prepare('UPDATE clients SET email_opt_out = 1, updated_at = datetime(\'now\') WHERE id = ?').run(client.id);
  res.send(`<html><body style="font-family:sans-serif;padding:40px;text-align:center">
    <h2>You've been unsubscribed</h2>
    <p>${client.first_name ? client.first_name + ', y' : 'Y'}ou won't receive any more automated emails from SLY.</p>
  </body></html>`);
});

export default router;
