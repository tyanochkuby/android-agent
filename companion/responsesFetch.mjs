// The ChatGPT plan endpoint can label its SSE stream as text/plain.
// Normalize only a response from that endpoint that actually starts with SSE.
export function responsesFetch(fetch) {
  return async (...args) => {
    const response = await fetch(...args);
    if (
      !response.ok ||
      response.url !== 'https://api.openai.com/v1/responses' ||
      !response.body ||
      response.headers
        .get('content-type')
        ?.split(';')[0]
        .trim()
        .toLowerCase() !== 'text/plain'
    ) {
      return response;
    }

    const reader = response.clone().body.getReader();
    const decoder = new TextDecoder();
    let prefix = '';
    try {
      while (prefix.length < 6) {
        const { done, value } = await reader.read();
        if (done) break;
        prefix += decoder.decode(value.subarray(0, 32 - prefix.length), {
          stream: true,
        });
      }
    } finally {
      void reader.cancel().catch(() => {});
    }
    if (!/^(event:|data:|:)/.test(prefix.trimStart())) return response;

    const headers = new Headers(response.headers);
    headers.set('content-type', 'text/event-stream');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}
