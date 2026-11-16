/**
 * Round-robin merge: the 1st item of each list, then the 2nd of each, and so
 * on. Used before the location analyzer's 20-image cap so every photo and
 * video gets some frames in, instead of the first video or two using it all.
 */
export function interleave<T>(lists: T[][]): T[] {
  const longest = Math.max(0, ...lists.map(l => l.length));
  const out: T[] = [];
  for (let i = 0; i < longest; i++) {
    for (const list of lists) if (i < list.length) out.push(list[i]);
  }
  return out;
}
