import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const appId = 'io.github.tyanochkuby.androidagent';
const keychainArgs = ['-a', appId, '-s', `${appId}.chatgpt`];
const security = '/usr/bin/security';

function readKey() {
  const result = spawnSync(
    security,
    ['find-generic-password', ...keychainArgs, '-w'],
    { encoding: 'utf8' },
  );
  if (result.status === 44) return undefined;
  const key = result.stdout?.trim();
  if (result.status !== 0 || !/^[a-f0-9]{64}$/.test(key ?? '')) {
    throw new Error(
      'Could not read the Android Agent key. Unlock macOS Keychain and try again.',
    );
  }
  return Buffer.from(key, 'hex');
}

function keychainEncryption() {
  return {
    id: 'macos-keychain-aes-256-gcm',
    isAvailable: () => true,
    encrypt(plaintext) {
      let key = readKey();
      if (!key) {
        const secret = randomBytes(32).toString('hex');
        // Pass the key through stdin so it does not appear in process arguments.
        spawnSync(security, ['-i'], {
          input: `add-generic-password ${keychainArgs.join(
            ' ',
          )} -w ${secret}\n`,
        });
        key = readKey();
        if (!key)
          throw new Error(
            'Could not save the Android Agent key in macOS Keychain.',
          );
      }
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const data = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
      ]);
      return Buffer.concat([nonce, cipher.getAuthTag(), data]);
    },
    decrypt(ciphertext) {
      const key = readKey();
      if (!key)
        throw new Error(
          'The Android Agent key is missing from macOS Keychain.',
        );
      const data = Buffer.from(ciphertext);
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        data.subarray(0, 12),
      );
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([
        decipher.update(data.subarray(28)),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}

/** Configures the same local ChatGPT session for the companion and debug scripts. */
export async function chatgptSession() {
  const config = {
    appName: 'Android Agent',
    appId,
    redirectPort: 0,
    sendHostId: true,
  };
  if (process.platform === 'darwin') {
    return {
      config: {
        ...config,
        storageDir: join(homedir(), '.config', appId),
        credentialEncryption: keychainEncryption(),
      },
      dispose: async () => {},
    };
  }

  const storageDir = await mkdtemp(join(tmpdir(), 'android-agent-chatgpt-'));
  const credentials = new Map();
  return {
    config: {
      ...config,
      storageDir,
      credentialEncryption: {
        id: 'process-memory',
        isAvailable: () => true,
        encrypt(plaintext) {
          // Credentials stay in memory. The temporary store receives an opaque handle.
          const handle = randomBytes(32).toString('hex');
          credentials.set(handle, plaintext);
          return Buffer.from(handle);
        },
        decrypt(ciphertext) {
          const handle = Buffer.from(ciphertext).toString();
          const plaintext = credentials.get(handle);
          if (plaintext === undefined)
            throw new Error('Restart ChatGPT sign-in.');
          for (const entry of credentials.keys()) {
            if (entry !== handle) credentials.delete(entry);
          }
          return plaintext;
        },
      },
    },
    dispose: () => rm(storageDir, { recursive: true, force: true }),
  };
}
