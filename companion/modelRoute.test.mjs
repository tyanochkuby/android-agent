import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelRoute } from './modelRoute.mjs';
import { openaiSocket } from './openaiSocket.mjs';

class FakeSocket extends EventTarget {
  readyState = 1;
  sent = [];
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  reply(event) {
    this.dispatchEvent(
      Object.assign(new Event('message'), { data: JSON.stringify(event) }),
    );
  }
  complete(text, inputTokens, cachedTokens = 0) {
    this.reply({ type: 'response.output_text.delta', delta: text });
    this.reply({
      type: 'response.completed',
      response: {
        usage: {
          input_tokens: inputTokens,
          input_tokens_details: { cached_tokens: cachedTokens },
        },
      },
    });
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
}

function setup() {
  const sockets = [];
  const live = openaiSocket({
    open: async () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  const fallback = { calls: 0 };
  const route = modelRoute({
    live,
    fallback: async () => {
      fallback.calls++;
      return { text: 'http' };
    },
  });
  return { route, sockets, fallback };
}

const request = {
  model: 'm',
  instructions: 'i',
  input: [{ role: 'user', content: 'hi' }],
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const signal = () => new AbortController().signal;

async function warm(route, sockets) {
  const first = route.respond(request, { signal: signal() });
  await tick();
  sockets[0].complete('one', 210_000);
  return first;
}

test('reuses one socket with full input and reports provider usage', async () => {
  const { route, sockets } = setup();
  assert.deepEqual(await warm(route, sockets), {
    text: 'one',
    inputTokens: 210_000,
    cachedTokens: 0,
  });
  const second = route.respond(request, { signal: signal(), liveOnly: true });
  await tick();
  sockets[0].complete('two', 211_000, 209_920);

  assert.deepEqual(await second, {
    text: 'two',
    inputTokens: 211_000,
    cachedTokens: 209_920,
  });
  assert.equal(sockets.length, 1);
  assert.deepEqual(sockets[0].sent[1], {
    type: 'response.create',
    ...request,
    store: false,
  });
});

test('a live-only request never opens a socket or falls back', async () => {
  const { route, sockets, fallback } = setup();
  await assert.rejects(
    route.respond(request, { signal: signal(), liveOnly: true }),
    /No live model connection/,
  );
  await warm(route, sockets);
  sockets[0].close();
  await assert.rejects(
    route.respond(request, { signal: signal(), liveOnly: true }),
    /No live model connection/,
  );
  assert.equal(sockets.length, 1);
  assert.equal(fallback.calls, 0);
});

test('a normal request cancels a running live-only request and reconnects', async () => {
  const { route, sockets } = setup();
  await warm(route, sockets);
  const background = route.respond(request, {
    signal: signal(),
    liveOnly: true,
  });
  await tick();
  const prompt = route.respond(request, { signal: signal() });

  await assert.rejects(background, /cancelled/);
  await tick();
  sockets[1].complete('prompt', 5);
  assert.deepEqual(await prompt, {
    text: 'prompt',
    inputTokens: 5,
    cachedTokens: 0,
  });
  assert.equal(sockets[0].readyState, 3);
});

test('a socket lost mid-request falls back to the other route for normal requests', async () => {
  const { route, sockets, fallback } = setup();
  await warm(route, sockets);
  const prompt = route.respond(request, { signal: signal() });
  await tick();
  sockets[0].close();
  assert.deepEqual(await prompt, { text: 'http' });
  assert.equal(fallback.calls, 1);
});

test('closing the route cancels a live-only request and drops the socket', async () => {
  const { route, sockets } = setup();
  await warm(route, sockets);
  const background = route.respond(request, {
    signal: signal(),
    liveOnly: true,
  });
  await tick();
  route.close();
  await assert.rejects(background, /cancelled/);
  assert.equal(sockets[0].readyState, 3);
});

test('provider errors report only their code', async () => {
  const { route, sockets, fallback } = setup();
  await warm(route, sockets);
  const background = route.respond(request, {
    signal: signal(),
    liveOnly: true,
  });
  await tick();
  sockets[0].reply({
    type: 'error',
    error: { code: 'rate_limit_exceeded', message: 'quoted prompt text' },
  });
  await assert.rejects(background, error => {
    assert.match(error.message, /rate_limit_exceeded/);
    assert.doesNotMatch(error.message, /quoted/);
    return true;
  });
  assert.equal(fallback.calls, 0);
});

test('a socket that cannot open falls back for normal requests', async () => {
  const fallback = { calls: 0 };
  const route = modelRoute({
    live: openaiSocket({
      open: async () => {
        throw new Error('Could not open the Responses connection.');
      },
    }),
    fallback: async () => {
      fallback.calls++;
      return { text: 'http' };
    },
  });
  assert.deepEqual(await route.respond(request, { signal: signal() }), {
    text: 'http',
  });
  assert.equal(fallback.calls, 1);
});
