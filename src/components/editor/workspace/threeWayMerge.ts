export interface ThreeWayMergeResult {
  text: string;
  conflicts: number;
  autoMerged: boolean;
}

interface LineHunk {
  start: number;
  end: number;
  replacement: string[];
}

// Keep the quadratic line diff bounded. Large files still get a deterministic
// conflict block instead of blocking the editor with an unbounded merge pass.
const MAX_DIFF_LINES = 1_600;

function lineHunks(base: string[], variant: string[]): LineHunk[] {
  if (base.length === variant.length && base.every((line, index) => line === variant[index])) return [];
  if (base.length > MAX_DIFF_LINES || variant.length > MAX_DIFF_LINES) {
    return [{ start: 0, end: base.length, replacement: variant }];
  }

  const lcs = Array.from({ length: base.length + 1 }, () => new Uint16Array(variant.length + 1));
  for (let i = base.length - 1; i >= 0; i -= 1) {
    const row = lcs[i]!;
    const next = lcs[i + 1]!;
    for (let j = variant.length - 1; j >= 0; j -= 1) {
      row[j] = base[i] === variant[j]
        ? (next[j + 1] ?? 0) + 1
        : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  type Operation = { kind: "equal"; line: string } | { kind: "delete" } | { kind: "insert"; line: string };
  const operations: Operation[] = [];
  let i = 0;
  let j = 0;
  while (i < base.length || j < variant.length) {
    if (i < base.length && j < variant.length && base[i] === variant[j]) {
      operations.push({ kind: "equal", line: base[i]! });
      i += 1;
      j += 1;
    } else if (i < base.length && (j >= variant.length || (lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0))) {
      operations.push({ kind: "delete" });
      i += 1;
    } else {
      operations.push({ kind: "insert", line: variant[j]! });
      j += 1;
    }
  }

  const hunks: LineHunk[] = [];
  let baseIndex = 0;
  let activeStart: number | null = null;
  let replacement: string[] = [];
  const flush = () => {
    if (activeStart === null) return;
    hunks.push({ start: activeStart, end: baseIndex, replacement });
    activeStart = null;
    replacement = [];
  };
  for (const operation of operations) {
    if (operation.kind === "equal") {
      flush();
      baseIndex += 1;
    } else if (operation.kind === "delete") {
      if (activeStart === null) activeStart = baseIndex;
      baseIndex += 1;
    } else {
      if (activeStart === null) activeStart = baseIndex;
      replacement.push(operation.line);
    }
  }
  flush();
  return hunks;
}

function applyHunks(base: string[], start: number, end: number, hunks: LineHunk[]): string[] {
  const output: string[] = [];
  let cursor = start;
  for (const hunk of hunks) {
    if (hunk.start > cursor) output.push(...base.slice(cursor, hunk.start));
    output.push(...hunk.replacement);
    cursor = Math.max(cursor, hunk.end);
  }
  if (cursor < end) output.push(...base.slice(cursor, end));
  return output;
}

function sameLines(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

function hunkTouchesCluster(hunk: LineHunk, clusterStart: number, clusterEnd: number): boolean {
  if (hunk.start < clusterEnd) return true;
  // An insertion exactly after a replacement is adjacent, not overlapping.
  // Insertions at the same point (an empty cluster) still belong together.
  return hunk.start === clusterEnd
    && (clusterStart === clusterEnd || hunk.end > hunk.start);
}

/**
 * Merge two edits made from the same saved baseline. Non-overlapping edits are
 * combined automatically; overlapping edits are emitted as standard conflict
 * markers so the editor can present a deterministic, user-editable result.
 */
export function threeWayMergeText(baseText: string, localText: string, diskText: string): ThreeWayMergeResult {
  if (localText === diskText) return { text: localText, conflicts: 0, autoMerged: true };
  if (localText === baseText) return { text: diskText, conflicts: 0, autoMerged: true };
  if (diskText === baseText) return { text: localText, conflicts: 0, autoMerged: true };

  const base = baseText.split("\n");
  const local = localText.split("\n");
  const disk = diskText.split("\n");
  const localHunks = lineHunks(base, local);
  const diskHunks = lineHunks(base, disk);
  const output: string[] = [];
  let localIndex = 0;
  let diskIndex = 0;
  let basePosition = 0;
  let conflicts = 0;

  while (localIndex < localHunks.length || diskIndex < diskHunks.length) {
    const nextLocal = localHunks[localIndex]?.start ?? Number.POSITIVE_INFINITY;
    const nextDisk = diskHunks[diskIndex]?.start ?? Number.POSITIVE_INFINITY;
    const nextStart = Math.min(nextLocal, nextDisk);
    if (nextStart > basePosition) {
      output.push(...base.slice(basePosition, nextStart));
      basePosition = nextStart;
    }

    const clusterStart = basePosition;
    let clusterEnd = clusterStart;
    const localCluster: LineHunk[] = [];
    const diskCluster: LineHunk[] = [];
    let expanded = true;
    while (expanded) {
      expanded = false;
      while (
        localIndex < localHunks.length
        && hunkTouchesCluster(localHunks[localIndex]!, clusterStart, clusterEnd)
      ) {
        const hunk = localHunks[localIndex++]!;
        localCluster.push(hunk);
        if (hunk.end > clusterEnd) clusterEnd = hunk.end;
        expanded = true;
      }
      while (
        diskIndex < diskHunks.length
        && hunkTouchesCluster(diskHunks[diskIndex]!, clusterStart, clusterEnd)
      ) {
        const hunk = diskHunks[diskIndex++]!;
        diskCluster.push(hunk);
        if (hunk.end > clusterEnd) clusterEnd = hunk.end;
        expanded = true;
      }
    }

    const baseSegment = base.slice(clusterStart, clusterEnd);
    const localSegment = applyHunks(base, clusterStart, clusterEnd, localCluster);
    const diskSegment = applyHunks(base, clusterStart, clusterEnd, diskCluster);
    if (sameLines(localSegment, diskSegment)) {
      output.push(...localSegment);
    } else if (sameLines(localSegment, baseSegment)) {
      output.push(...diskSegment);
    } else if (sameLines(diskSegment, baseSegment)) {
      output.push(...localSegment);
    } else {
      conflicts += 1;
      output.push(
        "<<<<<<< LOCAL",
        ...localSegment,
        "||||||| BASE",
        ...baseSegment,
        "=======",
        ...diskSegment,
        ">>>>>>> DISK",
      );
    }
    basePosition = clusterEnd;
  }
  if (basePosition < base.length) output.push(...base.slice(basePosition));
  return { text: output.join("\n"), conflicts, autoMerged: conflicts === 0 };
}
