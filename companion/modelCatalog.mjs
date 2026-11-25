// The DevKit's model list keeps only slugs and names. This reads each listed model's context
// window, in tokens, from the raw catalog response as it passes through `fetch`.
// A model whose entry has no positive integer `context_window` maps to null.
export function catalogFetch(fetch, contextWindows) {
  return async (...args) => {
    const response = await fetch(...args);
    if (response.ok && response.url === 'https://api.openai.com/v1/models') {
      const body = await response
        .clone()
        .json()
        .catch(() => null);
      contextWindows.clear();
      for (const model of Array.isArray(body?.models) ? body.models : []) {
        if (typeof model?.slug !== 'string') continue;
        const window = model.context_window;
        contextWindows.set(
          model.slug,
          Number.isSafeInteger(window) && window > 0 ? window : null,
        );
      }
    }
    return response;
  };
}
