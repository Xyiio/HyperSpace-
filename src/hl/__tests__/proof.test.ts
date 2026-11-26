import { describe, expect, it } from 'vitest';
import { buildMessage, parseMessage, validateIdea, validateProfile } from '../../../supabase/functions/_shared/proof';

describe('signed message', () => {
  it('round-trips through parseMessage', () => {
    const payload = { coin: 'xyz:TSLA', direction: 'long', entry: 400, target: 450, stop: 380, timeframe: '1w', body: 'Breakout over range highs' };
    const msg = buildMessage('post-idea', '0xabc0000000000000000000000000000000000001', Date.parse('2026-11-25T20:00:00.000Z'), payload as never);
    const parsed = parseMessage(msg);
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe('post-idea');
    expect(parsed!.address).toBe('0xabc0000000000000000000000000000000000001');
    expect(parsed!.payload).toEqual(payload);
  });
  it('rejects tampered text', () => {
    expect(parseMessage('hello')).toBeNull();
  });
});

describe('validateIdea', () => {
  const base = { coin: 'BTC', direction: 'long', body: 'Reclaiming the weekly open' };
  it('accepts a sane long', () => {
    expect(typeof validateIdea({ ...base, entry: '100', target: '120', stop: '90' })).toBe('object');
  });
  it('rejects a long with stop above entry', () => {
    expect(typeof validateIdea({ ...base, entry: '100', target: '120', stop: '110' })).toBe('string');
  });
  it('rejects a short with target above entry', () => {
    expect(typeof validateIdea({ ...base, direction: 'short', entry: '100', target: '120', stop: '130' })).toBe('string');
  });
  it('rejects a too-short body', () => {
    expect(typeof validateIdea({ ...base, body: 'moon' })).toBe('string');
  });
});

describe('validateProfile', () => {
  it('strips @ from handles and rejects bad ones', () => {
    expect(validateProfile({ displayName: 'Mitch', twitter: '@hyper_space' })).toMatchObject({ twitter: 'hyper_space' });
    expect(typeof validateProfile({ displayName: 'Mitch', twitter: 'bad handle!' })).toBe('string');
  });
});
