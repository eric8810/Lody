import { applicationJsonText, type HistoryIdentity } from '@loro-dev/roost/lody-history';
import type { ContentOp, IndexPut } from '@loro-dev/roost-node';
import { encodeRoostContentText } from './roost-history-port';

export const AGENT_RECEIPTS_TABLE = 'lody_agent_operation_receipts_v2';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const agentSegment = /^agent:[0-9a-f]{64}$/;
const digestHex = /^[0-9a-f]{64}$/;

export function agentReceiptKey(identity: HistoryIdentity): Uint8Array {
  if (
    identity.kind === 'publication' &&
    Object.keys(identity).length === 3 &&
    identity.businessId.length === 36 &&
    identity.segmentId.length === 70 &&
    uuid.test(identity.businessId) &&
    agentSegment.test(identity.segmentId)
  ) {
    // Tag + complete UUID + complete operation digest. Do not normalize identity strings.
    const key = Buffer.alloc(49);
    key.write(identity.businessId.replaceAll('-', ''), 1, 16, 'hex');
    key.write(identity.segmentId.slice(6), 17, 32, 'hex');
    return key;
  }
  // A disjoint tag preserves all other identities, including non-UUID session IDs.
  return Buffer.concat([Buffer.from([1]), Buffer.from(applicationJsonText(identity))]);
}

export function agentReceiptPut(identity: HistoryIdentity, digest: string): IndexPut {
  if (digest.length !== 64 || !digestHex.test(digest))
    throw new Error('Roost agent operation digest is invalid');
  const value = Buffer.alloc(33);
  value[0] = 2;
  value.write(digest, 1, 32, 'hex');
  return { table: AGENT_RECEIPTS_TABLE, key: agentReceiptKey(identity), value };
}

export function decodeAgentReceipt(value: Uint8Array): { digest: string } {
  if (value.length !== 33 || value[0] !== 2)
    throw new Error('Roost agent operation receipt is invalid');
  return { digest: Buffer.from(value.subarray(1)).toString('hex') };
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Stage only appendText against an owned snapshot; Native still validates the edit. */
export function stageRoostTextAppends<T>(content: T, ops: readonly ContentOp[]): T | undefined {
  if (
    !ops.length ||
    ops.some(
      (op) =>
        op.kind !== 'appendText' ||
        op.path.length < 2 ||
        !('key' in op.path[0]!) ||
        op.path[0].key !== 'content'
    )
  )
    return undefined;
  const next = structuredClone(content);
  for (const op of ops) {
    if (op.kind !== 'appendText') return undefined;
    let parent: unknown = next;
    for (let i = 1; i < op.path.length; i++) {
      const part = op.path[i]!;
      const key = 'key' in part ? part.key : Number(part.index);
      let value: unknown;
      if (parent instanceof Map && 'key' in part && parent.has(key)) value = parent.get(key);
      else if (
        ((Array.isArray(parent) && 'index' in part && part.index < BigInt(parent.length)) ||
          (object(parent) && !(parent instanceof Map) && 'key' in part)) &&
        Object.hasOwn(parent, key)
      )
        value = Reflect.get(parent, key);
      else return undefined;
      if (i === op.path.length - 1) {
        if (typeof value !== 'string') return undefined;
        if (parent instanceof Map) parent.set(key, value + op.text);
        else
          Object.defineProperty(parent, key, {
            value: value + op.text,
            enumerable: true,
            configurable: true,
            writable: true,
          });
      } else parent = value;
    }
  }
  return next;
}

/** Diff validated content, preserving unchanged subtrees and native scalar text offsets. */
export function roostContentPatches(before: unknown, after: unknown): ContentOp[] {
  const ops: ContentOp[] = [];
  const walk = (left: unknown, right: unknown, path: ContentOp['path']) => {
    if (Object.is(left, right)) return;
    if (right === undefined) {
      if (left !== undefined) ops.push({ kind: 'remove', path });
      return;
    }
    if (typeof left === 'string' && typeof right === 'string') {
      if (right.startsWith(left)) {
        ops.push({ kind: 'appendText', path, text: right.slice(left.length) });
        return;
      }
      const old = Array.from(left),
        next = Array.from(right);
      let from = 0,
        suffix = 0;
      while (from < old.length && from < next.length && old[from] === next[from]) from++;
      while (
        suffix < old.length - from &&
        suffix < next.length - from &&
        old[old.length - 1 - suffix] === next[next.length - 1 - suffix]
      )
        suffix++;
      ops.push({
        kind: 'spliceText',
        path,
        index: BigInt(from),
        delete: BigInt(old.length - from - suffix),
        text: next.slice(from, next.length - suffix).join(''),
      });
      return;
    }
    if (Array.isArray(left) && Array.isArray(right)) {
      if (left.length === right.length) {
        for (let i = 0; i < left.length; i++)
          walk(left[i], right[i] === undefined ? null : right[i], [...path, { index: BigInt(i) }]);
      } else {
        let from = 0;
        // Equal-length prefixes may contain edits: preserve those identities and
        // splice only the changed membership after their common length.
        const common = Math.min(left.length, right.length);
        while (from < common) {
          walk(left[from], right[from] === undefined ? null : right[from], [
            ...path,
            { index: BigInt(from) },
          ]);
          from++;
        }
        ops.push({
          kind: 'spliceArray',
          path,
          index: BigInt(common),
          delete: BigInt(left.length - common),
          valuesJson: encodeRoostContentText(right.slice(common)),
        });
      }
      return;
    }
    if (object(left) && object(right)) {
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)]))
        walk(
          Object.hasOwn(left, key) ? left[key] : undefined,
          Object.hasOwn(right, key) ? right[key] : undefined,
          [...path, { key }]
        );
      return;
    }
    ops.push({ kind: 'set', path, contentJson: encodeRoostContentText(right) });
  };
  walk(before, after, [{ key: 'content' }]);
  return ops;
}
