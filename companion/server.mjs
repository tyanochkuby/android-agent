import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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
const storageDir = await mkdtemp(join(tmpdir(), 'android-agent-chatgpt-'));

// The SDK gets opaque handles to process-local credentials, so its temporary
// storage cannot restore a ChatGPT session after the companion exits.
const credentials = new Map();
const chatgpt = createChatGPT({
  appName: 'Android Agent',
  appId: 'io.github.tyanochkuby.androidagent',
  storageDir,
  redirectPort: 0,
  sendHostId: true,
  credentialEncryption: {
    id: 'process-memory',
    isAvailable: () => true,
    encrypt(plaintext) {
      const handle = randomBytes(32).toString('hex');
      credentials.set(handle, plaintext);
      return Buffer.from(handle);
    },
    decrypt(ciphertext) {
      const plaintext = credentials.get(Buffer.from(ciphertext).toString());
      if (plaintext === undefined) throw new Error('Restart ChatGPT sign-in.');
      return plaintext;
    },
  },
});

const address = '127.0.0.1:8765';
const pairingCode = randomBytes(16).toString('hex');
const authorization = Buffer.from(`Bearer ${pairingCode}`);
let signingIn = false;
let signInError;
let model;

async function status() {
  const session = await chatgpt.getSession();
  return {
    ready: session.sharing,
    signingIn,
    ...(signInError && { error: signInError }),
  };
}

function signIn() {
  if (signingIn) return;
  signingIn = true;
  signInError = undefined;
  model = undefined;
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
  if (signingIn)
    throw new Error('Finish signing in on the companion computer.');
  if (!(await chatgpt.getSession()).sharing) {
    throw new Error('Sign in with ChatGPT and allow plan usage first.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2_000_000) throw new Error('The prompt context is too large.');
    chunks.push(chunk);
  }
  const { instructions, input } = JSON.parse(Buffer.concat(chunks).toString());
  model ??= (await chatgpt.listModels({ signal }))[0]?.slug;
  if (!model) throw new Error('The ChatGPT account has no available models.');
  return chatgpt.streamResponse({ model, instructions, input, signal });
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
  response.once('close', () => controller.abort());
  try {
    switch (`${request.method} ${request.url}`) {
      case 'GET /status':
        reply(200, await status());
        break;
      case 'POST /sign-in':
        signIn();
        reply(202, { ready: false, signingIn: true });
        break;
      case 'POST /infer':
        reply(
          200,
          await infer(
            request,
            AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]),
          ),
        );
        break;
      default:
        reply(404, { error: 'Unknown companion request.' });
    }
  } catch (error) {
    if (!response.destroyed) reply(400, { error: error.message });
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
    server.closeAllConnections();
    server.close();
    await rm(storageDir, { recursive: true, force: true });
    process.exit(0);
  });
}
if (process.argv.includes('--sign-in')) signIn();
