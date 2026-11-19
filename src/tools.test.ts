import { describe, expect, it } from 'vitest';
import { missingArgsError } from './tools';

describe('missingArgsError', () => {
  it('names the missing argument and the unrecognized one', () => {
    const err = missingArgsError('memory_auto_store', { content: 'x' });
    expect(err).toContain('missing required argument(s): text');
    expect(err).toContain('Unrecognized: content');
  });
  it('passes valid calls through', () => {
    expect(missingArgsError('memory_auto_store', { text: 'x' })).toBeNull();
    expect(missingArgsError('memory_stats', {})).toBeNull();
  });
  it('lets an empty string through so each tool keeps its own empty-input behavior', () => {
    expect(missingArgsError('memory_retrieve', { query: '' })).toBeNull();
  });
  it('ignores unknown tool names (handleToolCall reports those)', () => {
    expect(missingArgsError('no_such_tool', {})).toBeNull();
  });
});
