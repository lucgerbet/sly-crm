// The fulfilment axis of an order: workshop → client's hands. Separate from
// orders.status, which tracks the money (see the schema comment in db.js).

// Ordered — index doubles as progress, so the UI can render a stepper and the
// board can sort "how far along is this" without a second lookup table.
// Everything from `shipped` onwards is the journey to the CLIENT: shipped =
// left for the client with a tracking number, received = the client has it in
// hand, delivered = the handover is confirmed and the order is closed.
// `delivered` is not the end: it's the moment the verdict is pending. From
// there an order either closes (`finished`) or loops — through an alteration,
// or through a full remake that re-runs this same list with revision+1.
export const PRODUCTION_STAGES = [
  'not_started',
  'sent_to_workshop',
  'in_production',
  'ready',
  'shipped',
  'received',
  'delivered',
  'in_alteration',
  'finished',
];

export const PRODUCTION_LABELS = {
  not_started: 'À envoyer à l\'atelier',
  sent_to_workshop: 'Envoyée à l\'atelier',
  in_production: 'En production',
  ready: 'Prête',
  shipped: 'Expédiée',
  received: 'Reçue par le client',
  delivered: 'Livrée — en attente du retour client',
  in_alteration: 'En retouche',
  finished: 'Terminée',
};

// The alteration sub-cycle, run in order_alterations rather than on the order
// itself so several rounds can coexist with their own seamstress and dates.
export const ALTERATION_STATUSES = ['needed', 'booked', 'at_seamstress', 'shipped_back'];

export const ALTERATION_LABELS = {
  needed: 'Couturière à trouver',
  booked: 'Couturière trouvée',
  at_seamstress: 'Chez la couturière',
  shipped_back: 'Renvoyée au client',
};

export const ALTERATION_TIMESTAMP_COLUMN = {
  booked: 'booked_at',
  at_seamstress: 'dropped_off_at',
  shipped_back: 'shipped_back_at',
};

export function isValidAlterationStatus(s) {
  return ALTERATION_STATUSES.includes(s);
}

// Stages an order can be moved to by the plain "next stage" button. The three
// terminal/branching ones are driven by explicit actions instead (satisfied /
// alteration / redo), because "what comes after delivered" is a decision, not
// a step — defaulting it would quietly close orders nobody confirmed.
export function hasLinearNext(stage) {
  return stageIndex(stage) < stageIndex('delivered');
}

// Column stamped when an order first reaches each stage.
export const STAGE_TIMESTAMP_COLUMN = {
  sent_to_workshop: 'sent_to_workshop_at',
  in_production: 'in_production_at',
  ready: 'ready_at',
  shipped: 'shipped_at',
  received: 'received_at',
  delivered: 'delivered_at',
};

// Only these two notify the client — see the seed comment in db.js.
export const CLIENT_EMAIL_STAGES = {
  in_production: {
    subjectKey: 'production_in_production_subject',
    bodyKey: 'production_in_production_body',
  },
  shipped: {
    subjectKey: 'production_shipped_subject',
    bodyKey: 'production_shipped_body',
  },
};

export function isValidStage(stage) {
  return PRODUCTION_STAGES.includes(stage);
}

export function stageIndex(stage) {
  const i = PRODUCTION_STAGES.indexOf(stage);
  return i === -1 ? 0 : i;
}

// "Late" is judged against the WORKSHOP deadline, so it stops mattering the
// moment the workshop has finished — i.e. from `ready` onwards. Keeping the
// flag on through shipping would blame the workshop for transit time, and a
// red row that can no longer be acted on is just noise on the board.
export function isLate(order, today = new Date()) {
  if (!order.workshop_deadline) return false;
  if (stageIndex(order.production_status) >= stageIndex('ready')) return false;
  return new Date(order.workshop_deadline) < today;
}

// Columns wiped when a remake restarts the cycle, after being archived into
// production_history — leaving round 1's dates in place would make the board
// claim the new round had already shipped.
export const ROUND_RESET_COLUMNS = [
  'sent_to_workshop_at', 'in_production_at', 'ready_at',
  'shipped_at', 'received_at', 'delivered_at',
  'carrier', 'tracking_number', 'production_emails_sent',
];
