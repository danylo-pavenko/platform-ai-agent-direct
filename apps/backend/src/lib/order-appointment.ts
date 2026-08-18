/**
 * Booking orders store a pointer to Appointment in the note
 * (`appointmentId=<uuid>`). CRM truth lives on Appointment, not Order.
 */

const APPOINTMENT_ID_IN_NOTE_RE =
  /(?:^|\s)appointmentId=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export function parseAppointmentIdFromOrderNote(
  note: string | null | undefined,
): string | null {
  if (!note) return null;
  const match = note.match(APPOINTMENT_ID_IN_NOTE_RE);
  return match?.[1]?.toLowerCase() ?? null;
}
