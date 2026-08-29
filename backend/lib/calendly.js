export function isCalendlyConfigured() {
  return !!process.env.CALENDLY_API_TOKEN;
}

// Calendly's `calendly.event_scheduled` postMessage payload only ever
// carries `event.uri` — no start/end time (confirmed against Calendly's own
// embed docs and community reports; the sibling `date_and_time_selected`
// event's payload is empty, so it can't fill this gap either). `event.uri`
// doubles as the Calendly API resource URL, so we resolve the real time
// server-side instead of trusting anything client-supplied.
export async function resolveScheduledEvent(eventUri) {
  const res = await fetch(eventUri, {
    headers: { Authorization: `Bearer ${process.env.CALENDLY_API_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`Calendly API ${res.status}: ${await res.text()}`);
  }
  const { resource } = await res.json();
  return {
    startTime: resource.start_time,
    endTime: resource.end_time,
    location: resource.location?.join_url || resource.location?.location || null,
  };
}
