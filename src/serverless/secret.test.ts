import assert from "node:assert/strict";
import test from "node:test";
import {
  GetSecretValueCommand,
  type GetSecretValueCommandOutput,
  type SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { createSecretProvider } from "./secret.js";

const SECRET_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:commerce-webhook-example";
const FIRST_KEY = "first-local-test-key-with-at-least-32-characters";
const SECOND_KEY = "second-local-test-key-with-at-least-32-characters";

function fakeClient(
  send: (command: GetSecretValueCommand) => Promise<GetSecretValueCommandOutput>,
): Pick<SecretsManagerClient, "send"> {
  return { send } as Pick<SecretsManagerClient, "send">;
}

function secret(value: string): GetSecretValueCommandOutput {
  return { SecretString: value, $metadata: {} };
}

test("secret provider fetches the selected secret and preserves the exact raw key", async () => {
  const rawKey = ` ${FIRST_KEY} `;
  let calls = 0;
  const provider = createSecretProvider(fakeClient(async (command) => {
    calls += 1;
    assert.ok(command instanceof GetSecretValueCommand);
    assert.deepEqual(command.input, { SecretId: SECRET_ARN });
    return secret(rawKey);
  }), SECRET_ARN);

  assert.equal(await provider(), rawKey);
  assert.equal(await provider(), rawKey);
  assert.equal(calls, 1);
});

test("secret provider expires its cache at 60 seconds and picks up rotation", async () => {
  let time = 1_000;
  let calls = 0;
  const provider = createSecretProvider(fakeClient(async () => {
    calls += 1;
    return secret(calls === 1 ? FIRST_KEY : SECOND_KEY);
  }), SECRET_ARN, () => time);

  assert.equal(await provider(), FIRST_KEY);
  time += 59_999;
  assert.equal(await provider(), FIRST_KEY);
  assert.equal(calls, 1);
  time += 1;
  assert.equal(await provider(), SECOND_KEY);
  assert.equal(calls, 2);
});

test("secret provider does not preserve a cache across a backward clock jump", async () => {
  let time = 5_000;
  let calls = 0;
  const provider = createSecretProvider(fakeClient(async () => {
    calls += 1;
    return secret(calls === 1 ? FIRST_KEY : SECOND_KEY);
  }), SECRET_ARN, () => time);
  assert.equal(await provider(), FIRST_KEY);
  time = 4_000;
  assert.equal(await provider(), SECOND_KEY);
  assert.equal(calls, 2);
});

test("secret provider rejects a missing secret ARN before any SDK call", () => {
  const client = fakeClient(async () => {
    assert.fail("SDK must not be called without a secret ARN");
  });
  assert.throws(() => createSecretProvider(client, ""), /ARN is required/);
  assert.throws(() => createSecretProvider(client, "  "), /ARN is required/);
});

test("secret provider rejects missing, binary, short, and oversized values without caching them", async (t) => {
  const invalidValues: GetSecretValueCommandOutput[] = [
    { $metadata: {} },
    { SecretBinary: Buffer.from(FIRST_KEY), $metadata: {} },
    secret("short-key"),
    secret("x".repeat(4_097)),
    secret("€".repeat(1_366)),
  ];

  for (const [index, invalid] of invalidValues.entries()) {
    await t.test(`invalid secret response ${index + 1}`, async () => {
      let calls = 0;
      const provider = createSecretProvider(fakeClient(async () => {
        calls += 1;
        return calls === 1 ? invalid : secret(FIRST_KEY);
      }), SECRET_ARN);
      await assert.rejects(provider(), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Webhook secret must be raw text/);
        assert.ok(!error.message.includes(FIRST_KEY));
        return true;
      });
      assert.equal(await provider(), FIRST_KEY);
      assert.equal(calls, 2);
    });
  }
});

test("secret provider retries SDK errors and never serves an expired cached secret", async () => {
  let calls = 0;
  let time = 1_000;
  const failure = new Error("simulated service unavailable");
  const provider = createSecretProvider(fakeClient(async () => {
    calls += 1;
    if (calls === 2) throw failure;
    return secret(calls === 1 ? FIRST_KEY : SECOND_KEY);
  }), SECRET_ARN, () => time);

  assert.equal(await provider(), FIRST_KEY);
  time += 60_000;
  await assert.rejects(provider(), (error: unknown) => error === failure);
  assert.equal(await provider(), SECOND_KEY);
  assert.equal(calls, 3);
});

test("secret provider coalesces concurrent fetches", async () => {
  let calls = 0;
  let resolveFetch!: (response: GetSecretValueCommandOutput) => void;
  const provider = createSecretProvider(fakeClient(async () => {
    calls += 1;
    return new Promise<GetSecretValueCommandOutput>((resolve) => {
      resolveFetch = resolve;
    });
  }), SECRET_ARN);

  const first = provider();
  const second = provider();
  assert.equal(calls, 1);
  resolveFetch(secret(FIRST_KEY));
  assert.deepEqual(await Promise.all([first, second]), [FIRST_KEY, FIRST_KEY]);
  assert.equal(calls, 1);
});

test("secret provider accepts boundary key sizes", async () => {
  for (const value of ["x".repeat(32), "x".repeat(4_096)]) {
    const provider = createSecretProvider(fakeClient(async () => secret(value)), SECRET_ARN);
    assert.equal(await provider(), value);
  }
});
