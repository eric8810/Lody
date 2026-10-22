import { z } from 'zod';
import {
  roostContentPatches,
  stageRoostContent,
  contentPathKey,
  type TextAppendHints,
  type TextAppend,
} from './roost-content-patches';
import type { ContentOp } from '@loro-dev/roost-node';
import type { AgentHistoryMutationPath } from '@lody/shared';

const index = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const path = z.array(
  z.union([z.object({ key: z.string() }).strict(), z.object({ index }).strict()])
);
const deltaSchema = z
  .object({
    format: z.literal('lody-message-state'),
    version: z.literal(1),
    primaryTurnId: z.string().regex(/^[0-9a-f]{32}$/),
    patches: z.array(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('set'), path, contentJson: z.string() }).strict(),
        z.object({ kind: z.literal('remove'), path }).strict(),
        z.object({ kind: z.literal('appendText'), path, text: z.string() }).strict(),
        z
          .object({ kind: z.literal('spliceText'), path, index, delete: index, text: z.string() })
          .strict(),
        z
          .object({
            kind: z.literal('spliceArray'),
            path,
            index,
            delete: index,
            valuesJson: z.string(),
          })
          .strict(),
      ])
    ),
  })
  .strict();
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
/** The immutable primary is the baseline, so unchanged body bytes never enter state. */
export function createRoostMessageState(primary: unknown, primaryTurnId: string, next: unknown) {
  const patches = roostContentPatches(primary, next).map((op) => ({
    ...op,
    path: op.path.slice(1).map((part) => ('key' in part ? part : { index: Number(part.index) })),
    ...('index' in op ? { index: Number(op.index), delete: Number(op.delete) } : {}),
  }));
  // Native offsets are u64; application arrays/strings are bounded JS values.
  // Store safe JSON numbers rather than serializing bigint as an application field.
  return deltaSchema.parse({
    format: 'lody-message-state',
    version: 1,
    primaryTurnId,
    patches,
  });
}

/** Extend a compact state without rebuilding its immutable primary. Append
 * composition is restricted to the last related operation; other edits replace
 * only the authored top-level fields' baseline-relative deltas. */
export function planRoostMessageState(
  primary: unknown,
  primaryTurnId: string,
  previous: unknown,
  before: unknown,
  next: unknown,
  appends?: TextAppendHints,
  changes?: readonly AgentHistoryMutationPath[]
): { content: ReturnType<typeof createRoostMessageState>; appends?: TextAppendHints } {
  const old = deltaSchema.safeParse(previous);
  if (!old.success || old.data.primaryTurnId !== primaryTurnId)
    return { content: createRoostMessageState(primary, primaryTurnId, next) };
  const edits = roostContentPatches(before, next, appends, changes);
  const patches = old.data.patches.slice();
  const hints = new Map<string, TextAppend>();
  let composed = true;
  for (const edit of edits) {
    if (edit.kind !== 'appendText') {
      composed = false;
      break;
    }
    const target = edit.path
      .slice(1)
      .map((part) => ('key' in part ? part : { index: Number(part.index) }));
    const related = (a: typeof target, b: typeof target) => {
      const n = Math.min(a.length, b.length);
      return a.slice(0, n).every((part, i) => JSON.stringify(part) === JSON.stringify(b[i]));
    };
    let found = -1;
    for (let i = patches.length - 1; i >= 0; i--) {
      const patch = patches[i];
      if (patch && related(patch.path, target)) {
        found = i;
        break;
      }
    }
    const prior = patches[found];
    if (prior) {
      if (prior.kind !== 'appendText' || JSON.stringify(prior.path) !== JSON.stringify(target)) {
        composed = false;
        break;
      }
      const value = prior.text + edit.text;
      patches[found] = { ...prior, text: value };
      hints.set(
        contentPathKey([
          { key: 'content' },
          { key: 'patches' },
          { index: BigInt(found) },
          { key: 'text' },
        ]),
        { previous: prior.text, value, text: edit.text }
      );
    } else patches.push({ kind: 'appendText', path: target, text: edit.text });
  }
  if (composed) return { content: { ...old.data, patches }, appends: hints };
  if (
    changes?.length &&
    changes.every((change) => change.path.length && typeof change.path[0] === 'string') &&
    old.data.patches.every((op) => op.path[0] && 'key' in op.path[0])
  ) {
    const fields = new Set(changes.map((change) => change.path[0]));
    const fresh = roostContentPatches(primary, next, undefined, changes).map((op) => ({
      ...op,
      path: op.path.slice(1).map((part) => ('key' in part ? part : { index: Number(part.index) })),
      ...('index' in op ? { index: Number(op.index), delete: Number(op.delete) } : {}),
    }));
    return {
      content: deltaSchema.parse({
        ...old.data,
        patches: [
          ...old.data.patches.filter((op) => {
            const first = op.path[0];
            return !first || !('key' in first) || !fields.has(first.key);
          }),
          ...fresh,
        ],
      }),
    };
  }
  return { content: createRoostMessageState(primary, primaryTurnId, next) };
}

/** Reconstruct application content without changing the signed primary. */
export function projectRoostMessageState(
  primary: unknown,
  primaryTurnId: string,
  stored: unknown
): unknown {
  // Previous adapters stored a complete entry, always including its business ID.
  if (object(stored) && typeof stored.id === 'string') return structuredClone(stored);
  const delta = deltaSchema.parse(stored);
  if (delta.primaryTurnId !== primaryTurnId) throw new Error('Roost state primary mismatch');
  const ops: ContentOp[] = delta.patches.map(
    (op) =>
      ({
        ...op,
        path: [
          { key: 'content' },
          ...op.path.map((part) => ('key' in part ? part : { index: BigInt(part.index) })),
        ],
        ...('index' in op ? { index: BigInt(op.index), delete: BigInt(op.delete) } : {}),
      }) as ContentOp
  );
  const result = stageRoostContent(primary, ops);
  if (result === undefined) throw new Error('Roost state content operation is invalid');
  return result;
}
