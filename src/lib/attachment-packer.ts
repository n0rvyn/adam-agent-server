import { effectivePriority } from "./artifact-priority.js";

export const BASE64_INFLATION = 1.33;

export interface PackInput {
  id: string;
  sizeBytes: number;
  priority?: number;
  mime?: string;
}

export interface PackResult {
  included: PackInput[];
  dropped: PackInput[];
  firstOverflowWarning?: boolean; // true ⇔ highest-priority item dropped due to cap, smaller items packed instead
}

export type PackOutcome = PackResult | { firstItemOverflow: PackInput };

export function packAttachmentsToCap(items: PackInput[], capBytes: number): PackOutcome {
  if (items.length === 0) return { included: [], dropped: [] };
  const sorted = [...items].sort((a, b) => {
    const pa = effectivePriority(a);
    const pb = effectivePriority(b);
    if (pa !== pb) return pa - pb;
    return b.sizeBytes - a.sizeBytes; // tie: bigger first
  });
  const first = sorted[0];
  if (first.sizeBytes * BASE64_INFLATION > capBytes) {
    // Branch A: single item that overflows → true all-or-nothing
    if (sorted.length === 1) {
      return { firstItemOverflow: first };
    }
    // Branch B: multi-item, first overflows → attempt packing remaining items
    const remaining = sorted.slice(1);
    const included: PackInput[] = [];
    const droppedTail: PackInput[] = [];
    let consumed = 0;
    for (const item of remaining) {
      const need = item.sizeBytes * BASE64_INFLATION;
      if (consumed + need <= capBytes) {
        included.push(item);
        consumed += need;
      } else {
        droppedTail.push(item);
      }
    }
    if (included.length === 0) {
      // None of the remaining items fit either → true all-or-nothing
      return { firstItemOverflow: first };
    }
    return { included, dropped: [first, ...droppedTail], firstOverflowWarning: true };
  }
  // Branch C: first item fits → standard greedy packing
  const included: PackInput[] = [];
  const dropped: PackInput[] = [];
  let consumed = 0;
  for (const item of sorted) {
    const need = item.sizeBytes * BASE64_INFLATION;
    if (consumed + need <= capBytes) {
      included.push(item);
      consumed += need;
    } else {
      dropped.push(item);
    }
  }
  return { included, dropped };
}
