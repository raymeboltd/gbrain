/** Pure privacy fence for reviewed source-event updates on developed pages. */

export const SOURCE_EVENT_UPDATES_BEGIN = '<!-- gbrain:source-event-updates:begin -->';
export const SOURCE_EVENT_UPDATES_END = '<!-- gbrain:source-event-updates:end -->';

/**
 * Remove the private block before remote reads, versions, chunking,
 * embeddings or search. Malformed markers fail closed by removing the whole
 * value; a partial private fence must never become readable data.
 */
export function stripPrivateSourceEventUpdates(text: string): string {
  const begins = text.split(SOURCE_EVENT_UPDATES_BEGIN).length - 1;
  const ends = text.split(SOURCE_EVENT_UPDATES_END).length - 1;
  if (begins === 0 && ends === 0) return text;
  if (begins !== 1 || ends !== 1) return '';
  const start = text.indexOf(SOURCE_EVENT_UPDATES_BEGIN);
  const end = text.indexOf(SOURCE_EVENT_UPDATES_END, start);
  if (start < 0 || end < start) return '';
  return text.slice(0, start) + text.slice(end + SOURCE_EVENT_UPDATES_END.length);
}
