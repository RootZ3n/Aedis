import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { redactText, redactObject, redactForReceipt, redactForModel, redactError } from "./redaction.js";

describe("redactText", () => {
  it("redacts OpenAI-style sk- keys", () => {
    const input = "key is sk-abc123def456ghi789jkl012mno";
    assert.equal(redactText(input), "key is <redacted:api_key>");
  });

  it("redacts sk-proj- keys", () => {
    const input = "sk-proj-abc123def456ghi789jkl012mno";
    assert.equal(redactText(input), "<redacted:api_key>");
  });

  it("redacts sk-or- keys", () => {
    const input = "sk-or-v1-abc123def456ghi789jkl012";
    assert.equal(redactText(input), "<redacted:api_key>");
  });

  it("redacts sk-ant- keys", () => {
    const input = "sk-ant-api03-abc123def456ghi789jkl012";
    assert.equal(redactText(input), "<redacted:api_key>");
  });

  it("redacts ghp_ tokens", () => {
    const input = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    assert.equal(redactText(input), "<redacted:api_key>");
  });

  it("redacts github_pat_ tokens", () => {
    const input = "github_pat_abc123def456ghi789jkl012mno";
    assert.equal(redactText(input), "<redacted:api_key>");
  });

  it("redacts Bearer tokens", () => {
    const input = 'Authorization: Bearer eyABCDEF1234567890abcdef';
    assert.ok(redactText(input).includes("<redacted:token>"));
    assert.ok(!redactText(input).includes("eyABCDEF"));
  });

  it("redacts .env-style API key assignments", () => {
    assert.equal(redactText("OPENAI_API_KEY=sk-foo123"), "OPENAI_API_KEY=<redacted:secret>");
    assert.equal(redactText("ANTHROPIC_API_KEY=sk-ant-xxx"), "ANTHROPIC_API_KEY=<redacted:secret>");
    assert.equal(redactText("TOKEN=abc123"), "TOKEN=<redacted:secret>");
    assert.equal(redactText("SECRET=hunter2"), "SECRET=<redacted:secret>");
    assert.equal(redactText("PASSWORD=p@ssw0rd!"), "PASSWORD=<redacted:secret>");
  });

  it("redacts private key blocks", () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----
MIIBogIBAAJBALRi...
-----END RSA PRIVATE KEY-----`;
    assert.equal(redactText(pem), "<redacted:private_key>");
  });

  it("redacts JWTs", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    assert.equal(redactText(`token: ${jwt}`), "token: <redacted:jwt>");
  });

  it("redacts emails", () => {
    const input = "contact zen@example.com for help";
    assert.equal(redactText(input), "contact <redacted:email> for help");
  });

  it("redacts Unix home paths", () => {
    assert.equal(redactText("/home/zen/.config/aedis"), "<redacted:path>/.config/aedis");
  });

  it("redacts Windows user paths", () => {
    assert.equal(redactText("C:\\Users\\JohnDoe\\Documents"), "<redacted:path>\\Documents");
  });

  it("does not redact short sk- strings that are not real keys", () => {
    // Less than 20 chars after sk- — not a real key
    assert.equal(redactText("sk-test"), "sk-test");
  });

  it("does not double-redact already-redacted labels", () => {
    const input = "<redacted:api_key> and <redacted:token>";
    assert.equal(redactText(input), input);
  });

  it("handles empty and null-ish input", () => {
    assert.equal(redactText(""), "");
  });

  it("preserves normal code content", () => {
    const code = 'const x = 42;\nif (x > 0) { return "ok"; }';
    assert.equal(redactText(code), code);
  });

  it("preserves test dummy values that are short", () => {
    const input = 'const TEST_TOKEN = "test_value";';
    // "test_value" is not long enough to match any pattern
    assert.equal(redactText(input), input);
  });
});

describe("redactObject", () => {
  it("redacts strings in nested objects", () => {
    const input = {
      prompt: "Use key sk-abc123def456ghi789jkl012mno",
      meta: { email: "user@example.com" },
    };
    const result = redactObject(input);
    assert.ok(result.prompt.includes("<redacted:api_key>"));
    assert.equal(result.meta.email, "<redacted:email>");
  });

  it("handles arrays", () => {
    const input = ["sk-abc123def456ghi789jkl012mno", "normal text"];
    const result = redactObject(input);
    assert.equal(result[0], "<redacted:api_key>");
    assert.equal(result[1], "normal text");
  });

  it("does not mutate original object", () => {
    const original = { key: "sk-abc123def456ghi789jkl012mno" };
    const frozen = JSON.parse(JSON.stringify(original));
    redactObject(original);
    assert.deepEqual(original, frozen);
  });

  it("passes through numbers and booleans", () => {
    const input = { count: 42, ok: true, label: "safe" };
    assert.deepEqual(redactObject(input), input);
  });

  it("handles null and undefined values", () => {
    const input = { a: null, b: undefined, c: "text" };
    const result = redactObject(input);
    assert.equal(result.a, null);
    assert.equal(result.b, undefined);
    assert.equal(result.c, "text");
  });

  it("handles deeply nested structures", () => {
    const input = {
      level1: {
        level2: {
          level3: [{ secret: "OPENAI_API_KEY=sk-real-key-here" }],
        },
      },
    };
    const result = redactObject(input);
    assert.ok(result.level1.level2.level3[0].secret.includes("<redacted:secret>"));
  });
});

describe("redactForReceipt", () => {
  it("redacts receipt-shaped objects", () => {
    const receipt = {
      runId: "run-1",
      prompt: "Fix bug with key sk-abc123def456ghi789jkl012mno",
      providerAttempts: [
        { provider: "openai", errorMsg: "auth failed for sk-abc123def456ghi789jkl012mno" },
      ],
    };
    const result = redactForReceipt(receipt);
    assert.ok(result.prompt.includes("<redacted:api_key>"));
    assert.ok(result.providerAttempts[0].errorMsg.includes("<redacted:api_key>"));
    assert.equal(result.runId, "run-1"); // non-sensitive preserved
  });
});

describe("redactForModel", () => {
  it("strips secrets from prompt text", () => {
    const result = redactForModel("My key is sk-abc123def456ghi789jkl012mno please fix");
    assert.ok(result.includes("<redacted:api_key>"));
    assert.ok(!result.includes("sk-abc123"));
  });
});

describe("redactError", () => {
  it("redacts Error objects", () => {
    const err = new Error("Failed with key sk-abc123def456ghi789jkl012mno");
    const result = redactError(err);
    assert.ok(result.includes("<redacted:api_key>"));
    assert.ok(!result.includes("sk-abc123"));
  });

  it("redacts string errors", () => {
    const result = redactError("token: ghp_abcdefghijklmnopqrstuvwxyz1234567890");
    assert.ok(result.includes("<redacted:api_key>"));
  });
});
