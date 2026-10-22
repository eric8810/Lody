import { describe, expect, it } from 'vitest';
import {
  createRoostMessageState,
  projectRoostMessageState,
  planRoostMessageState,
} from '../src/session/roost-message-state';

import {
  coalesceAgentTextAppends,
  roostContentPatches,
  stageRoostContent,
} from '../src/session/roost-content-patches';

const primaryId = '01'.repeat(16);
describe('Roost message state', () => {
  it('preserves the sealed baseline and reconstructs Unicode, deletions and nested arrays', () => {
    const primary = {
      id: 'assistant',
      finished: true,
      endedAt: 42,
      items: [{ type: 'text', text: 'a🙂bc🚀d' }, { output: { rows: ['one', 'two'] } }],
      unknown: { preserved: 'large unchanged value'.repeat(4096) },
    };
    const original = structuredClone(primary);
    const next = {
      id: 'assistant',
      finished: false,
      items: [
        { type: 'text', text: 'a🙂XYZ🚀d' },
        { output: { rows: ['changed'] } },
        { flag: null },
      ],
      unknown: primary.unknown,
    };
    const state = createRoostMessageState(primary, primaryId, next);
    expect(JSON.stringify(state).length).toBeLessThan(2048);
    expect(projectRoostMessageState(primary, primaryId, state)).toEqual(next);
    expect(primary).toEqual(original);
    expect(projectRoostMessageState(primary, primaryId, original)).toEqual(original);
  });

  it('supports optional-field absence and increasing corrections relative to the same primary', () => {
    const primary = { id: 'a', text: '😀prefix', list: [1, 2, 3], optional: 'remove' };
    for (let size = 0; size < 32; size++) {
      const next = {
        id: 'a',
        text: primary.text + '🙂'.repeat(size),
        list: Array.from({ length: size }, (_, n) => n),
        optional: undefined,
      };
      const state = createRoostMessageState(primary, primaryId, next);
      expect(projectRoostMessageState(primary, primaryId, state)).toEqual(
        JSON.parse(JSON.stringify(next))
      );
    }
  });

  it('composes resumed streaming and unrelated edits without copying the sealed primary', () => {
    const primary = {
      id: 'a',
      finished: true,
      endedAt: 42,
      items: [{ type: 'text', text: 'base🙂' }],
      untouched: { text: 'retained'.repeat(32768) },
    };
    let before = { ...primary, finished: false };
    let state = createRoostMessageState(primary, primaryId, before);
    for (let index = 0; index < 32; index++) {
      const previous = before.items[0]?.text ?? '';
      const delta = `${index}🚀`;
      const next = { ...before, items: [{ type: 'text', text: previous + delta }] };
      const plan = planRoostMessageState(
        primary,
        primaryId,
        state,
        before,
        next,
        coalesceAgentTextAppends(
          [{ turnId: 'a', itemIndex: 0, previous, value: previous + delta, text: delta }],
          'a'
        ),
        [{ turnId: 'a', path: ['items', 0, 'text'] }]
      );
      const ops = roostContentPatches(state, plan.content, plan.appends);
      expect(stageRoostContent(state, ops)).toEqual(plan.content);
      state = plan.content;
      const projected = projectRoostMessageState(primary, primaryId, state) as typeof next;
      expect(projected).toEqual(next);
      expect(projected.untouched).toBe(primary.untouched);
      expect(projected.items).not.toBe(primary.items);
      expect(state.patches.length).toBeLessThanOrEqual(2);
      before = next;
    }
    const next = { ...before, endedAt: undefined, plan: [{ content: 'new', status: 'pending' }] };
    const plan = planRoostMessageState(primary, primaryId, state, before, next, undefined, [
      { turnId: 'a', path: ['endedAt'] },
      { turnId: 'a', path: ['plan'] },
    ]);
    expect(projectRoostMessageState(primary, primaryId, plan.content)).toEqual(
      JSON.parse(JSON.stringify(next))
    );
    expect(primary.items[0]?.text).toBe('base🙂');
    expect(primary.finished).toBe(true);
  });

  it('rejects another primary, invalid offsets and inherited paths', () => {
    const primary = { id: 'a', text: '🙂' };
    const state = createRoostMessageState(primary, primaryId, { ...primary, text: 'next' });
    expect(() => projectRoostMessageState(primary, '02'.repeat(16), state)).toThrow(
      'primary mismatch'
    );
    for (const patches of [
      [{ kind: 'spliceText', path: [{ key: 'text' }], index: 2, delete: 0, text: 'bad' }],
      [{ kind: 'set', path: [{ key: '__proto__' }, { key: 'polluted' }], contentJson: 'true' }],
      [{ kind: 'set', path: [{ index: -1 }], contentJson: 'null' }],
    ])
      expect(() => projectRoostMessageState(primary, primaryId, { ...state, patches })).toThrow();
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });

  it('keeps arbitrary own JSON keys without modifying prototypes', () => {
    const primary = { id: 'a' };
    const next = JSON.parse('{"id":"a","__proto__":{"polluted":true}}');
    expect(
      projectRoostMessageState(
        primary,
        primaryId,
        createRoostMessageState(primary, primaryId, next)
      )
    ).toEqual(next);
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });
});
