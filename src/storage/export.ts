// CSV / JSON export helpers.
// CSV output is Excel-friendly: CRLF row endings + UTF-8 BOM.

export function csvEscape(v: string | number | undefined | null): string {
  if (v === undefined || v === null || (typeof v === 'number' && !Number.isFinite(v))) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCsv(headers: string[], rows: (string | number | undefined | null)[][]): string {
  const lines = [headers.map(csvEscape).join(',')];
  for (const r of rows) lines.push(r.map(csvEscape).join(','));
  return '\ufeff' + lines.join('\r\n') + '\r\n'; // BOM helps Excel detect UTF-8
}

export function download(filename: string, content: string, mime = 'text/csv;charset=utf-8'): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
