import fs from 'node:fs';

// Byte ranges allow browsers to seek without fetching the entire video again.
export function sendVideo(request, response, filename, downloadName, preview = false) {
  const size = fs.statSync(filename).size;
  let start = 0, end = size - 1, status = 200;
  if (request.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
    let valid = Boolean(match && (match[1] || match[2]));
    if (valid) {
      if (match[1]) {
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      } else {
        const suffix = Number(match[2]);
        valid = Number.isSafeInteger(suffix) && suffix > 0;
        start = Math.max(0, size - suffix);
      }
      valid = valid && Number.isSafeInteger(start) && Number.isSafeInteger(end)
        && start >= 0 && start < size && end >= start;
    }
    if (!valid) {
      response.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    status = 206;
  }
  const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes',
    'Content-Disposition': `${preview ? 'inline' : 'attachment'}; filename="${downloadName}"`,
    'Content-Length': Math.max(0, end - start + 1), 'Cache-Control': 'no-store' };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  response.writeHead(status, headers);
  if (request.method === 'HEAD' || size === 0) { response.end(); return; }
  const stream = fs.createReadStream(filename, { start, end });
  stream.on('error', () => response.destroy());
  response.on('close', () => stream.destroy());
  stream.pipe(response);
}
