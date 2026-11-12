/** Local times, as the files show them. */
const two = (n: number) => String(n).padStart(2, "0");

/** HH:MM */
export function hhmm(d: Date = new Date()): string {
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** YYYY-MM-DD HH:MM */
export function stamp(d: Date = new Date()): string {
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${hhmm(d)}`;
}
