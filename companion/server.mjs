import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chatgptSession } from './chatgptSession.mjs';
import { catalogFetch } from './modelCatalog.mjs';
import { modelRoute } from './modelRoute.mjs';
import { openaiSocket } from './openaiSocket.mjs';
import { responsesFetch } from './responsesFetch.mjs';

const contextWindows = new Map();
globalThis.fetch = catalogFetch(
  responsesFetch(globalThis.fetch),
  contextWindows,
);

const devkit = process.argv[2];
if (!devkit) {
  console.error(
    'Pass the path to the built Sign in with ChatGPT DevKit checkout.',
  );
  process.exit(1);
}
const { createChatGPT } = await import(
  pathToFileURL(resolve(devkit, 'packages/local/dist/index.js')).href
);
const sessionStore = await chatgptSession();
const chatgpt = createChatGPT(sessionStore.config);
// A DevKit built with `devkit-responses-socket.patch` opens authenticated Responses sockets and
// owns their credentials. Without it every request uses the DevKit's HTTP stream, which reports no
// usage, so idle compaction never runs.
const live =
  typeof chatgpt.openResponsesSocket === 'function'
    ? openaiSocket({ open: signal => chatgpt.openResponsesSocket({ signal }) })
    : undefined;
if (!live) {
  console.warn(
    'This DevKit build cannot open a Responses socket. Requests use HTTP and report no usage.',
  );
}
const route = modelRoute({
  live,
  fallback: (request, signal) => chatgpt.streamResponse({ ...request, signal }),
});

const address = '127.0.0.1:8765';
const pairingCode = randomBytes(16).toString('hex');
const authorization = Buffer.from(`Bearer ${pairingCode}`);
let signingIn = false;
let signInError;
let model;
let sessionId = randomBytes(16).toString('hex');
let activeInferences = 0;

// Picks the first eligible model once per sign-in. `contextWindow` is null when the catalog
// does not state one.
async function selectModel(signal) {
  if (model) return model;
  const checkedSession = sessionId;
  const slug = (await chatgpt.listModels({ signal }))[0]?.slug;
  if (!slug) throw new Error('The ChatGPT account has no available models.');
  const selected = { slug, contextWindow: contextWindows.get(slug) ?? null };
  // A sign-in that started meanwhile picks its own model.
  if (checkedSession === sessionId) model = selected;
  return selected;
}

async function status(signal) {
  const checkedSession = sessionId;
  const session = await chatgpt.getSession();
  const ready = session.sharing && !signingIn && checkedSession === sessionId;
  const selected = ready ? await selectModel(signal) : undefined;
  return {
    ready: ready && checkedSession === sessionId,
    sessionId: checkedSession,
    signingIn,
    ...(selected && { contextWindow: selected.contextWindow }),
    ...(signInError && { error: signInError }),
  };
}

function signIn() {
  if (signingIn) return;
  if (activeInferences)
    throw new Error(
      'Wait for the current request to finish before signing in.',
    );
  signingIn = true;
  sessionId = randomBytes(16).toString('hex');
  signInError = undefined;
  model = undefined;
  route.close();
  chatgpt
    .signIn({ reconsent: true })
    .then(
      session => {
        if (!session.sharing)
          signInError = 'Allow ChatGPT plan usage to run prompts.';
      },
      error => {
        signInError = error.message;
      },
    )
    .finally(() => {
      signingIn = false;
    });
}

async function infer(request, signal) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2_000_000) throw new Error('The prompt context is too large.');
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const { instructions, input, sessionId: expectedSession } = body;
  const liveOnly = body.liveOnly === true;
  const assertSession = () => {
    if (signingIn || expectedSession !== sessionId) {
      throw new Error(
        'The companion session changed. Check the connection again.',
      );
    }
  };
  assertSession();
  // Sign-in cancels a live-only request instead of waiting for it.
  if (!liveOnly) activeInferences++;
  try {
    if (!(await chatgpt.getSession()).sharing) {
      throw new Error('Sign in with ChatGPT and allow plan usage first.');
    }
    const { slug } = await selectModel(signal);
    // A sign-in during the awaits above must not receive history sent under the old session.
    assertSession();
    const result = await route.respond(
      { model: slug, instructions, input },
      { signal, liveOnly },
    );
    if (result.inputTokens !== undefined) {
      console.log(
        `${liveOnly ? 'Live-only' : 'Prompt'} request: ${
          result.inputTokens
        } input tokens, ${result.cachedTokens ?? 0} cached.`,
      );
    }
    return result;
  } finally {
    if (!liveOnly) activeInferences--;
  }
}

const server = createServer(async (request, response) => {
  const supplied = Buffer.from(request.headers.authorization ?? '');
  if (
    request.headers.host !== address ||
    supplied.length !== authorization.length ||
    !timingSafeEqual(supplied, authorization)
  ) {
    response.writeHead(403).end();
    return;
  }

  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Cache-Control', 'no-store');
  function reply(code, body) {
    response.writeHead(code).end(JSON.stringify(body));
  }

  const controller = new AbortController();
  response.once('close', () => {
    if (!response.writableFinished) controller.abort();
  });
  let inferenceDeadline;
  try {
    switch (`${request.method} ${request.url}`) {
      case 'GET /status':
        reply(200, await status(controller.signal));
        break;
      case 'POST /sign-in':
        signIn();
        reply(202, { ready: false, signingIn: true });
        break;
      case 'POST /infer':
        inferenceDeadline = AbortSignal.timeout(45_000);
        reply(
          200,
          await infer(
            request,
            AbortSignal.any([controller.signal, inferenceDeadline]),
          ),
        );
        break;
      default:
        reply(404, { error: 'Unknown companion request.' });
    }
  } catch (error) {
    if (response.destroyed) return;
    if (inferenceDeadline?.aborted) {
      reply(504, { error: 'ChatGPT did not finish within 45 seconds.' });
      return;
    }
    reply(400, { error: error.message });
  }
});

server.listen(8765, '127.0.0.1', () => {
  console.log(
    `Android Agent companion on ${address}\nPairing code: ${pairingCode}`,
  );
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    chatgpt.cancelSignIn();
    route.close();
    server.closeAllConnections();
    server.close();
    await sessionStore.dispose();
    process.exit(0);
  });
}
if (
  process.argv.includes('--sign-in') &&
  !(await chatgpt.getSession()).sharing
) {
  signIn();
}
