/**
 * Timezone maths. Luxon rather than hand-rolled Intl because the whole point is to take a
 * wall-clock time *at the target location* and resolve it to a UTC instant — and Melbourne
 * flips AEST/AEDT, so "21:30 on 3 October" is genuinely ambiguous without a real tz library.
 */
import { DateTime } from 'luxon';
import tzLookup from 'tz-lookup';

/** IANA zone for a coordinate. Offline lookup — no network at showtime. */
export function zoneFor(lat, lon) {
  try {
    return tzLookup(lat, lon);
  } catch {
    return 'UTC';
  }
}

/**
 * "2026-08-01" + "21:30" in a zone -> UTC epoch ms.
 * Returns null if the input is malformed or lands in a DST gap.
 */
export function wallToUtc(date, time, zone) {
  const dt = DateTime.fromISO(`${date}T${time}`, { zone });
  return dt.isValid ? dt.toMillis() : null;
}

/** Epoch ms -> the {date, time} a control panel field should show for that zone. */
export function utcToWall(ms, zone) {
  const dt = DateTime.fromMillis(ms, { zone });
  return { date: dt.toFormat('yyyy-MM-dd'), time: dt.toFormat('HH:mm') };
}

/**
 * en-AU because it is the only locale that resolves Australian zones to real
 * abbreviations (AEST/AEDT) rather than "GMT+10". Zones outside the regions Node's
 * bundled small-ICU has short names for fall back to "GMT±N", which is still correct and
 * readable — not worth shipping full-icu over.
 */
const LOCALE = 'en-AU';
const upperMeridiem = (s) => s.replace(/\b(am|pm)\b/, (m) => m.toUpperCase());

/** "10:00 PM AEST" — what the overlay prints next to a delay. */
export function formatLocal(ms, zone) {
  return upperMeridiem(DateTime.fromMillis(ms, { zone }).setLocale(LOCALE).toFormat('h:mm a ZZZZ'));
}

/** Zone abbreviation only, e.g. "AEST". */
export function zoneAbbr(ms, zone) {
  return DateTime.fromMillis(ms, { zone }).setLocale(LOCALE).toFormat('ZZZZ');
}

/**
 * Next occurrence of a wall-clock time in a zone — today if it is still ahead, else
 * tomorrow. Used to seed a sensible default go-live on first boot.
 */
export function nextOccurrence(time, zone, nowMs = Date.now()) {
  const now = DateTime.fromMillis(nowMs, { zone });
  const [h, m] = time.split(':').map(Number);
  let target = now.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  if (target <= now) target = target.plus({ days: 1 });
  return target.toMillis();
}
