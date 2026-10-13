export async function encodeLog(csv) {
  if (typeof CompressionStream === 'undefined') return { csv };
  const stream = new Blob([csv]).stream().pipeThrough(new CompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return { encoding: 'gzip-base64', encoded: btoa(binary) };
}
export async function decodeLog(record) {
  if (record.csv) return record.csv; // Preserve earlier, uncompressed saved logs.
  if (record.encoding !== 'gzip-base64') throw new Error('Saved log format is not supported. Upload the CSV again.');
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot reopen the saved log. Upload the CSV again.');
  const bytes = Uint8Array.from(atob(record.encoded), c => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}
