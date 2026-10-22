import type { AgentHistoryTextAppend, AgentHistoryMutationPath } from '@lody/shared';
import { decodeJson } from '@loro-dev/roost';
import {
  applicationJsonText,
  toApplicationJson,
  type HistoryIdentity,
} from '@loro-dev/roost/lody-history';
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

export type TextAppend = Pick<AgentHistoryTextAppend, 'previous' | 'value' | 'text'>;
export type TextAppendHints = ReadonlyMap<string, TextAppend>;
export const contentPathKey = (path: ContentOp['path']) =>
  JSON.stringify(path, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
export function coalesceAgentTextAppends(
  appends: readonly AgentHistoryTextAppend[],
  turnId: string
): TextAppendHints {
  const result = new Map<number, TextAppend>(),
    invalid = new Set<number>();
  for (const append of appends) {
    if (append.turnId !== turnId || invalid.has(append.itemIndex)) continue;
    const prior = result.get(append.itemIndex);
    if (prior && prior.value !== append.previous) {
      result.delete(append.itemIndex);
      invalid.add(append.itemIndex);
      continue;
    }
    result.set(
      append.itemIndex,
      prior
        ? { previous: prior.previous, value: append.value, text: prior.text + append.text }
        : append
    );
  }
  return new Map(
    [...result].map(([index, value]) => [
      contentPathKey([
        { key: 'content' },
        { key: 'items' },
        { index: BigInt(index) },
        { key: 'text' },
      ]),
      value,
    ])
  );
}
const textAppendAt = (path: ContentOp['path'], appends?: TextAppendHints) =>
  appends?.get(contentPathKey(path));

/** Apply verified content operations with private path copies. Native remains
 * authoritative for limits, ownership, sequence and final edited JSON validity. */
export function stageRoostContent<T>(
  content: T,
  ops: readonly ContentOp[],
  appends?: TextAppendHints,
  representation: 'application' | 'sdk' = 'application'
): T | undefined {
  const removed = Symbol('removed');
  const json = (text: string): unknown => {
    const value = decodeJson(new TextEncoder().encode(text));
    return representation === 'sdk' ? value : toApplicationJson(value);
  };
  const offset = (text: string, scalar: bigint): number | undefined => {
    if (scalar < 0n || scalar > BigInt(text.length)) return undefined;
    let index = 0,
      count = 0n;
    for (const value of text) {
      if (count === scalar) return index;
      index += value.length;
      count++;
    }
    return count === scalar ? index : undefined;
  };
  let next: unknown = content;
  for (const op of ops) {
    const root = op.path[0];
    if (!root || !('key' in root) || root.key !== 'content') return undefined;
    const append = textAppendAt(op.path, appends);
    const edit = (value: unknown): { value: unknown } | undefined => {
      if (op.kind === 'set') return { value: json(op.contentJson) };
      if (op.kind === 'remove') return { value: removed };
      if (op.kind === 'spliceArray') {
        const values = json(op.valuesJson);
        if (
          !Array.isArray(value) ||
          !Array.isArray(values) ||
          op.index < 0n ||
          op.delete < 0n ||
          op.index > BigInt(value.length) ||
          op.delete > BigInt(value.length) - op.index
        )
          return undefined;
        const at = Number(op.index),
          end = at + Number(op.delete);
        return { value: value.slice(0, at).concat(values, value.slice(end)) };
      }
      if (typeof value !== 'string') return undefined;
      if (op.kind === 'appendText')
        return {
          value:
            append && value === append.previous && op.text === append.text
              ? append.value
              : value + op.text,
        };
      const from = offset(value, op.index),
        to = offset(value, op.index + op.delete);
      if (from === undefined || to === undefined || op.delete < 0n) return undefined;
      return { value: value.slice(0, from) + op.text + value.slice(to) };
    };
    const visit = (parent: unknown, depth: number): { value: unknown } | undefined => {
      if (depth === op.path.length) return edit(parent);
      const part = op.path[depth];
      if (!part) return undefined;
      const key = 'key' in part ? part.key : Number(part.index);
      const map = parent instanceof Map;
      const array = Array.isArray(parent);
      if (
        map
          ? !('key' in part)
          : array
            ? !('index' in part) || part.index < 0n || part.index >= BigInt(parent.length)
            : !object(parent) || !('key' in part)
      )
        return undefined;
      const exists = map ? parent.has(key) : Object.hasOwn(parent as object, key);
      if (!exists && (depth !== op.path.length - 1 || op.kind !== 'set')) return undefined;
      const old = map ? parent.get(key) : Reflect.get(parent as object, key);
      const changed = visit(old, depth + 1);
      if (!changed || (array && changed.value === removed)) return undefined;
      if (map) {
        const copy = new Map(parent);
        if (changed.value === removed) copy.delete(key);
        else copy.set(key, changed.value);
        return {
          value: exists
            ? copy
            : new Map([...copy].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))),
        };
      }
      const copy = array ? parent.slice() : { ...(parent as Record<string, unknown>) };
      if (changed.value === removed) Reflect.deleteProperty(copy, key);
      else
        Object.defineProperty(copy, key, {
          value: changed.value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      return {
        value:
          !array && !exists
            ? Object.fromEntries(
                Object.entries(copy).sort(([a], [b]) =>
                  Buffer.compare(Buffer.from(a), Buffer.from(b))
                )
              )
            : copy,
      };
    };
    const staged = visit(next, 1);
    if (!staged || staged.value === removed) return undefined;
    next = staged.value;
  }
  return next as T;
}

/** Diff validated content, preserving unchanged subtrees and native scalar text offsets. */
export function roostContentPatches(
  before: unknown,
  after: unknown,
  appends?: TextAppendHints,
  changes?: readonly AgentHistoryMutationPath[]
): ContentOp[] {
  const ops: ContentOp[] = [];
  const walk = (left: unknown, right: unknown, path: ContentOp['path']) => {
    if (Object.is(left, right)) return;
    if (right === undefined) {
      if (left !== undefined) ops.push({ kind: 'remove', path });
      return;
    }
    if (typeof left === 'string' && typeof right === 'string') {
      const append = textAppendAt(path, appends);
      if (append && left === append.previous && right === append.value) {
        if (append.text) ops.push({ kind: 'appendText', path, text: append.text });
        return;
      }
      if (right.startsWith(left)) {
        ops.push({ kind: 'appendText', path, text: right.slice(left.length) });
        return;
      }
      let oldFrom = 0,
        newFrom = 0,
        from = 0;
      while (oldFrom < left.length && newFrom < right.length) {
        const oldScalar = left.codePointAt(oldFrom),
          newScalar = right.codePointAt(newFrom);
        if (oldScalar !== newScalar) break;
        oldFrom += oldScalar !== undefined && oldScalar > 0xffff ? 2 : 1;
        newFrom += newScalar !== undefined && newScalar > 0xffff ? 2 : 1;
        from++;
      }
      const previousScalar = (text: string, end: number) => {
        const low = text.charCodeAt(end - 1);
        return low >= 0xdc00 &&
          low <= 0xdfff &&
          end > 1 &&
          text.charCodeAt(end - 2) >= 0xd800 &&
          text.charCodeAt(end - 2) <= 0xdbff
          ? end - 2
          : end - 1;
      };
      let oldEnd = left.length,
        newEnd = right.length;
      while (oldEnd > oldFrom && newEnd > newFrom) {
        const a = previousScalar(left, oldEnd),
          b = previousScalar(right, newEnd);
        if (left.codePointAt(a) !== right.codePointAt(b)) break;
        oldEnd = a;
        newEnd = b;
      }
      let deleted = 0;
      for (let i = oldFrom; i < oldEnd; deleted++) i += (left.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
      ops.push({
        kind: 'spliceText',
        path,
        index: BigInt(from),
        delete: BigInt(deleted),
        text: right.slice(newFrom, newEnd),
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
  if (
    changes &&
    object(before) &&
    object(after) &&
    !changes.some((change) => !change.path.length)
  ) {
    // Validation can normalize siblings inside an authored field. Select its
    // complete validated subtree, never unrelated message fields or bodies.
    const fields = new Set(
      changes
        .map((change) => change.path[0])
        .filter((key): key is string => typeof key === 'string')
    );
    for (const key of fields)
      walk(
        Object.hasOwn(before, key) ? before[key] : undefined,
        Object.hasOwn(after, key) ? after[key] : undefined,
        [{ key: 'content' }, { key }]
      );
  } else walk(before, after, [{ key: 'content' }]);
  return ops;
}
