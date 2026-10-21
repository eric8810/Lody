import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Identity } from '@loro-dev/roost';
import { fromApplicationJson } from '@loro-dev/roost/lody-history';
import { createRoostHistoryReader } from '@lody/shared/session-data';
import { createRoostReadPort } from '../src/session/roost-history-port';
import {
  createRoostHistoryChanges,
  RENDERER_HISTORY_CHANGES_TABLE,
} from '../src/session/roost-history-changes';
import {
  encodeRoostHistoryChange,
  decodeRoostHistoryChange,
} from '../src/session/roost-history-change-codec';

const assistantContent = (text: string, finished = false) =>
  fromApplicationJson({
    role: 'assistant',
    timestamp: '2026-10-03T00:00:01.000Z',
    items: [{ type: 'text', text }],
    finished,
  });

describe('local Roost history writes', () => {
  it('appends and seals assistant output, merges late segments, and records permission separately', async () => {
    const [{ RoostNativeClient }, { NodeLodyHistory }] = await Promise.all([
      import('@loro-dev/roost-node'),
      import('@loro-dev/roost/lody-history'),
    ]);
    const directory = await mkdtemp(join(tmpdir(), 'lody-roost-writes-'));
    const seed = new Uint8Array(32).fill(9);
    const owner = Identity.fromSeed(seed).owner();
    const client = new RoostNativeClient({
      dbPath: join(directory, 'history.db'),
      seed,
      allowedOwners: [owner],
      clockMs: 1_700_000_000_000n,
      maxQueuedRequests: 16,
      maxQueuedBytes: 8 * 1024 * 1024,
    });

    try {
      await client.ready;
      const stream = client.stream('lody-writes');
      const history = new NodeLodyHistory(stream, owner);
      const primary = await history.accept({
        kind: 'message',
        businessId: 'assistant-1',
        segmentId: 'primary',
        parents: [],
        content: assistantContent('hello'),
      });

      await history.append(primary.turnId, 1n, [
        {
          kind: 'appendText',
          path: [{ key: 'items' }, { index: 0n }, { key: 'text' }],
          text: ' world',
        },
      ]);
      await history.finish(primary.turnId, 2n);

      const beforePermission = await stream.readTurn(primary.turnId);
      const late = await history.accept({
        kind: 'message',
        businessId: 'assistant-1',
        segmentId: 'late-output',
        parents: [],
        content: assistantContent('late', true),
      });

      const reader = createRoostHistoryReader(
        createRoostReadPort(history, () => ({
          initial: history.readProjectedMessages(),
          unsubscribe: () => {},
        }))
      );
      const projected = await reader.readAll();
      expect(projected).toHaveLength(1);
      expect(projected[0]).toMatchObject({
        id: 'assistant-1',
        role: 'assistant',
        finished: true,
      });
      expect(projected[0]?.items).toEqual([
        { type: 'text', text: 'hello world' },
        { type: 'text', text: 'late' },
      ]);

      const permission = await history.respondPermission({
        requestId: 'permission-1',
        assistantBusinessId: 'assistant-1',
        outcome: fromApplicationJson('approved'),
        parents: [],
      });
      const permissionRetry = await history.respondPermission({
        requestId: 'permission-1',
        assistantBusinessId: 'assistant-1',
        outcome: fromApplicationJson('approved'),
        parents: [],
      });
      expect(permission.created).toBe(true);
      expect(permissionRetry.created).toBe(false);
      expect([...permissionRetry.turnId]).toEqual([...permission.turnId]);

      const afterPermission = await stream.readTurn(primary.turnId);
      expect(afterPermission).toEqual(beforePermission);
      expect(late.created).toBe(true);
      const permissionTurn = await stream.readTurn(permission.turnId);
      expect(permissionTurn.kind).toBe('found');
      if (permissionTurn.kind === 'found') expect(permissionTurn.turn.sealed).not.toBeNull();
    } finally {
      await client.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30000);
});

it('recovers verified native change intervals and refuses a missing interval after reopen', async () => {
  const { RoostNativeClient } = await import('@loro-dev/roost-node');
  const directory = await mkdtemp(join(tmpdir(), 'lody-roost-changes-'));
  const seed = new Uint8Array(32).fill(17);
  const owner = Identity.fromSeed(seed).owner();
  const dbPath = join(directory, 'history.db');
  let client = new RoostNativeClient({
    dbPath,
    seed,
    allowedOwners: [owner],
    clockMs: 1_700_000_000_000n,
    maxQueuedRequests: 16,
    maxQueuedBytes: 8 * 1024 * 1024,
  });
  try {
    await client.ready;
    let stream = client.stream('synthetic-changes');
    const scope = createHash('sha256').update(owner).update('synthetic-changes').digest('hex');
    let journal = createRoostHistoryChanges(
      () => stream,
      () => scope
    );
    const initial = await journal.checkpoint(0n);
    const first = await stream.create([], '{"text":"first"}');
    await journal.record(0n, 1n, { kind: 'changed', businessIds: ['logical-first'] }, true);
    await stream.edit(first.updates[0]!.turnId, 1n, [
      { kind: 'appendText', path: [{ key: 'text' }], text: ' update' },
    ]);
    await journal.record(1n, 2n, { kind: 'structure', from: 4, to: 5 }, true, [
      'logical-early-status',
    ]);
    const recovered = await journal.read(initial, 2n);
    expect(recovered).toMatchObject({
      state: 'ready',
      from: 4,
      ids: ['logical-first', 'logical-early-status'],
    });
    await client.close();
    client = new RoostNativeClient({
      dbPath,
      seed,
      allowedOwners: [owner],
      clockMs: 1_700_000_000_000n,
      maxQueuedRequests: 16,
      maxQueuedBytes: 8 * 1024 * 1024,
    });
    await client.ready;
    stream = client.stream('synthetic-changes');
    journal = createRoostHistoryChanges(
      () => stream,
      () => scope
    );
    expect(await journal.read(initial, 2n)).toEqual(recovered);
    await stream.create([], '{"text":"unrecorded"}');
    await stream.create([], '{"text":"later"}');
    await journal.record(3n, 4n, { kind: 'changed', businessIds: ['later'] }, true);
    expect(await journal.read(initial, 4n)).toMatchObject({ state: 'reset' });
    const foreign = createRoostHistoryChanges(
      () => stream,
      () => '00'.repeat(32)
    );
    expect(await foreign.read(initial, 4n)).toMatchObject({ state: 'reset' });
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

describe('Production Roost compact renderer receipts', () => {
  const scope = 'abcdef0123456789'.repeat(4);
  const nonce = 'fedcba98-7654-4321-8765-0123456789ab';
  const otherIds = [
    nonce.toUpperCase(),
    `${nonce}\n`,
    '中文🙂',
    '',
    '\ud800',
    '\udc00',
    'e\u0301',
    'é',
    '\ufeff',
  ];

  it('preserves exact identities and full-width cursors, rejecting malformed encodings', () => {
    const receipt = {
      scope,
      nonce,
      before: '9007199254740993',
      through: '18446744073709551615',
      reset: false,
      ids: [nonce],
    };
    for (const ids of [[], [nonce], otherIds, [nonce, ...otherIds]]) {
      for (const from of [undefined, 0, Number.MAX_SAFE_INTEGER]) {
        const expected = { ...receipt, ids, from, reset: from !== undefined };
        expect(decodeRoostHistoryChange(encodeRoostHistoryChange(expected))).toEqual(expected);
      }
    }
    const encoded = Buffer.from(encodeRoostHistoryChange(receipt));
    // A one-ID receipt retains all 128 UUID bits, both u64 cursors and the 256-bit scope.
    expect(encoded.length).toBe(86);
    for (let length = 0; length < encoded.length; length++)
      expect(() => decodeRoostHistoryChange(encoded.subarray(0, length))).toThrow();
    const corrupt = [Buffer.concat([encoded, Buffer.from([0])]), Buffer.from('{"version":1}')];
    for (const [offset, value] of [
      [0, 1],
      [1, 8],
      [66, 255],
    ] as const) {
      const bytes = Buffer.from(encoded);
      bytes[offset] = value;
      corrupt.push(bytes);
    }
    // Generation replacement can reset the native cursor; retain that reset evidence.
    const replaced = { ...receipt, through: '0', reset: true };
    expect(decodeRoostHistoryChange(encodeRoostHistoryChange(replaced))).toEqual(replaced);
    const unsafePosition = Buffer.from(encodeRoostHistoryChange({ ...receipt, from: 0 }));
    unsafePosition.writeBigUInt64BE(0xffffffffffffffffn, 66);
    corrupt.push(unsafePosition);
    const jsonHeader = Buffer.from(
      encodeRoostHistoryChange({ ...receipt, ids: ['text'] })
    ).subarray(0, 66);
    for (const body of [
      Buffer.from('[1]'),
      Buffer.from('["text"]x'),
      Buffer.from([91, 34, 255, 34, 93]),
    ])
      corrupt.push(Buffer.concat([jsonHeader, body]));
    for (const bytes of corrupt) expect(() => decodeRoostHistoryChange(bytes)).toThrow();
    expect(() => encodeRoostHistoryChange({ ...receipt, scope: scope.toUpperCase() })).toThrow();
    expect(() => encodeRoostHistoryChange({ ...receipt, scope: `${scope.slice(1)}\n` })).toThrow();
    expect(() => encodeRoostHistoryChange({ ...receipt, nonce: nonce.toUpperCase() })).toThrow();
    expect(() =>
      encodeRoostHistoryChange({ ...receipt, from: Number.MAX_SAFE_INTEGER + 1 })
    ).toThrow();
  });

  it('recovers a paged receipt chain after reopen and refuses gaps, foreign identities and intervening mutations', async () => {
    const { RoostNativeClient } = await import('@loro-dev/roost-node');
    const seed = new Uint8Array(32).fill(67);
    const directory = await mkdtemp(join(tmpdir(), 'lody-renderer-receipts-'));
    const options = {
      dbPath: join(directory, 'renderer-receipts.db'),
      seed,
      allowedOwners: [Identity.fromSeed(seed).owner()],
      maxQueuedRequests: 32,
      maxQueuedBytes: 8 * 1024 * 1024,
    };
    let client = new RoostNativeClient(options);
    try {
      await client.ready;
      let stream = client.stream('renderer-receipts');
      const changes = createRoostHistoryChanges(
        () => stream,
        () => scope
      );
      const peers = createRoostHistoryChanges(
        () => stream,
        () => scope
      );
      const [checkpoint, concurrent] = await Promise.all([
        changes.checkpoint(0n),
        peers.checkpoint(0n),
      ]);
      expect(concurrent).toBe(checkpoint);
      const advance = (cursor: number) =>
        stream.writeBatch([], {
          indexPuts: [
            {
              table: 'app_synthetic_events',
              key: Buffer.from(String(cursor)),
              value: Buffer.from([1]),
              emitEvent: true,
            },
          ],
        });
      for (let index = 0; index < 129; index++) {
        await advance(index);
        await changes.record(
          BigInt(index),
          BigInt(index + 1),
          index === 128
            ? { kind: 'structure', from: 3, to: 129 }
            : { kind: 'changed', businessIds: [nonce] },
          true,
          index === 128 ? otherIds : []
        );
      }
      const expected = {
        state: 'ready',
        checkpoint: await changes.checkpoint(129n),
        from: 3,
        ids: [nonce, ...otherIds],
      };
      expect(await changes.read(checkpoint, 129n)).toEqual(expected);
      await client.close();
      client = new RoostNativeClient(options);
      await client.ready;
      stream = client.stream('renderer-receipts');
      expect(await changes.read(checkpoint, 129n)).toEqual(expected);
      expect(await changes.read(expected.checkpoint, 129n)).toEqual({
        state: 'ready',
        checkpoint: expected.checkpoint,
        ids: [],
      });
      const wrongScope = JSON.parse(checkpoint) as string[];
      wrongScope[0] = '00'.repeat(32);
      expect(await changes.read(JSON.stringify(wrongScope), 129n)).toMatchObject({
        state: 'reset',
      });
      const wrongNonce = JSON.parse(checkpoint) as string[];
      wrongNonce[2] = `${wrongNonce[2]}x`;
      expect(await changes.read(JSON.stringify(wrongNonce), 129n)).toMatchObject({
        state: 'reset',
      });

      const entry = {
        table: RENDERER_HISTORY_CHANGES_TABLE,
        key: Buffer.from('0000000000000001', 'hex'),
      };
      const [stored] = await stream.readIndex([entry]);
      if (!stored) throw new Error('Expected persisted renderer receipt');
      const original = decodeRoostHistoryChange(stored);
      for (const change of [{ before: '1' }, { reset: true }, { scope: '00'.repeat(32) }]) {
        await stream.writeBatch([], {
          indexPuts: [{ ...entry, value: encodeRoostHistoryChange({ ...original, ...change }) }],
        });
        expect(await changes.read(checkpoint, 129n)).toMatchObject({ state: 'reset' });
      }
      await stream.writeBatch([], {
        indexPuts: [{ ...entry, value: encodeRoostHistoryChange({ ...original, through: '2' }) }],
      });
      await expect(changes.read(checkpoint, 129n)).rejects.toThrow('receipt is inconsistent');
      await stream.writeBatch([], { indexPuts: [{ ...entry, value: stored.subarray(0, 10) }] });
      await expect(changes.read(checkpoint, 129n)).rejects.toThrow('receipt is invalid');
      await stream.writeBatch([], { indexPuts: [{ ...entry, value: stored }] });
      await expect(changes.record(129n, 130n, undefined, true)).rejects.toThrow();
      expect(await changes.read(checkpoint, 129n)).toEqual(expected);
      // A native commit without its derived receipt must still require full recovery.
      await advance(129);
      expect(await changes.read(expected.checkpoint, 130n)).toMatchObject({ state: 'reset' });
    } finally {
      await client.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
