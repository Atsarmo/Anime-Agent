export async function getText(url, { fetcher = fetch, signal } = {}) {
  const response = await fetcher(url, { signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)]), headers: { Accept: 'application/json, text/html', 'User-Agent': 'Anime-Agent/0.1' } });
  if (!response.ok) throw Error(`HTTP ${response.status}`);
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2 * 1024 * 1024) throw Error('响应过大');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
}
