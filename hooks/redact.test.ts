import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs hook module, no types
import { redact } from './gaussian-lib.mjs';

describe('redact', () => {
  it.each([
    ['bearer header', 'curl -H "Authorization: Bearer sk-abc123def456ghi789jkl" https://api.example.com'],
    ['openai key', 'export OPENAI_API_KEY=sk-proj-AbCdEf123456789012345678'],
    ['github pat', 'git remote add origin https://github_pat_11ABCDEFG0aBcDeFgHiJkL@github.com/x/y'],
    ['github classic', 'gh auth login --with-token ghp_16CharsMinimumAAAA'],
    ['gitlab pat', 'glpat-AbCdEfGhIjKlMnOpQrSt'],
    ['slack token', 'xoxb-123456789012-abcdefghijkl'],
    ['aws access key', 'aws configure set AKIAIOSFODNN7EXAMPLE'],
    ['google api key', 'AIzaSyD-1234567890abcdefghijklmnopqrstu'],
    ['npm token', 'npm_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['huggingface token', 'hf_AbCdEfGhIjKlMnOpQr'],
    ['jwt', 'token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N'],
    ['url credentials', 'psql postgres://admin:hunter2@db.example.com:5432/mydb'],
    ['password flag', 'mysql --password hunter2secret -u root'],
    ['env assignment', 'DATABASE_PASSWORD=s3cr3tvalue ./run.sh'],
    ['quoted secret', 'STRIPE_SECRET_KEY="rk_live_abcdefghijklmnop123456"'],
  ])('redacts %s', (_name, input) => {
    expect(redact(input)).toContain('[REDACTED]');
  });

  it('redacts a PEM private key block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKC\n-----END RSA PRIVATE KEY-----';
    expect(redact(pem)).toBe('[REDACTED]');
  });

  it.each([
    ['ordinary command', 'npm run build && node dist/index.js --port 8080'],
    ['prose memory', 'Replaced Redis with D1 for session storage — zero egress fees, edge-native'],
    ['file paths', 'vim src/retrieval.ts && npx tsc --noEmit'],
    ['the word token', 'the token budget per query is around 700 tokens'],
    ['the letters sk', 'sk is short for secret key in their docs'],
  ])('leaves %s untouched', (_name, input) => {
    expect(redact(input)).toBe(input);
  });

  it('redacts before truncation would clip the pattern', () => {
    const long = `${'a'.repeat(180)} Bearer sk-abc123def456ghi789jkl`;
    expect(redact(long).slice(0, 200)).not.toContain('sk-abc123');
  });
});
