export type LineCoverageStatus = "covered" | "uncovered" | "partial";

export interface LineCoverage {
  /** 1-based line number */
  line: number;
  hits: number;
  branchesTotal?: number;
  branchesCovered?: number;
  status: LineCoverageStatus;
}

export interface FileCoverage {
  path: string;
  linesTotal: number;
  linesCovered: number;
  percentage: number;
  lines: Map<number, LineCoverage>;
}

export interface WorkspaceCoverageReport {
  timestamp: number;
  files: Map<string, FileCoverage>;
  totalLines: number;
  totalCovered: number;
  totalPercentage: number;
}

/**
 * Parse LCOV string format (lcov.info).
 */
export function parseLcovCoverage(content: string): WorkspaceCoverageReport {
  const files = new Map<string, FileCoverage>();
  let currentFile: string | null = null;
  let currentLines = new Map<number, LineCoverage>();
  let currentTotal = 0;
  let currentCovered = 0;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("SF:")) {
      currentFile = line.slice(3).trim();
      currentLines = new Map();
      currentTotal = 0;
      currentCovered = 0;
      continue;
    }

    if (line.startsWith("DA:") && currentFile) {
      const parts = line.slice(3).split(",");
      const lineNr = parseInt(parts[0], 10);
      const hits = parseInt(parts[1] ?? "0", 10);
      if (!isNaN(lineNr)) {
        currentTotal++;
        if (hits > 0) currentCovered++;
        currentLines.set(lineNr, {
          line: lineNr,
          hits,
          status: hits > 0 ? "covered" : "uncovered",
        });
      }
      continue;
    }

    if (line.startsWith("BRDA:") && currentFile) {
      // BRDA:<line>,<block>,<branch>,<taken>
      const parts = line.slice(5).split(",");
      const lineNr = parseInt(parts[0], 10);
      const taken = parts[3] === "-" ? 0 : parseInt(parts[3] ?? "0", 10);
      if (!isNaN(lineNr)) {
        const existing = currentLines.get(lineNr);
        if (existing) {
          const bTotal = (existing.branchesTotal ?? 0) + 1;
          const bCovered = (existing.branchesCovered ?? 0) + (taken > 0 ? 1 : 0);
          const status: LineCoverageStatus =
            bCovered === 0 ? "uncovered" : bCovered === bTotal ? "covered" : "partial";
          currentLines.set(lineNr, {
            ...existing,
            branchesTotal: bTotal,
            branchesCovered: bCovered,
            status,
          });
        }
      }
      continue;
    }

    if (line === "end_of_record" && currentFile) {
      const percentage = currentTotal > 0 ? Math.round((currentCovered / currentTotal) * 100) : 100;
      files.set(currentFile, {
        path: currentFile,
        linesTotal: currentTotal,
        linesCovered: currentCovered,
        percentage,
        lines: currentLines,
      });
      currentFile = null;
    }
  }

  let totalLines = 0;
  let totalCovered = 0;
  for (const f of files.values()) {
    totalLines += f.linesTotal;
    totalCovered += f.linesCovered;
  }
  const totalPercentage = totalLines > 0 ? Math.round((totalCovered / totalLines) * 100) : 100;

  return {
    timestamp: Date.now(),
    files,
    totalLines,
    totalCovered,
    totalPercentage,
  };
}

/**
 * Parse JaCoCo XML format string.
 */
export function parseJacocoXmlCoverage(content: string): WorkspaceCoverageReport {
  const files = new Map<string, FileCoverage>();
  // Match <package name="..."> ... <sourcefile name="..."> <line nr="..." mi="..." ci="..." mb="..." cb="..."/>
  const sourcefileRegex = /<sourcefile\s+name="([^"]+)">([\s\S]*?)<\/sourcefile>/g;
  const lineRegex = /<line\s+([^>]+)\/>/g;

  let match: RegExpExecArray | null;
  while ((match = sourcefileRegex.exec(content)) !== null) {
    const filename = match[1];
    const body = match[2];
    const lines = new Map<number, LineCoverage>();
    let total = 0;
    let covered = 0;

    let lineMatch: RegExpExecArray | null;
    while ((lineMatch = lineRegex.exec(body)) !== null) {
      const attrs = lineMatch[1];
      const nr = parseInt(attrs.match(/nr="(\d+)"/)?.[1] ?? "0", 10);
      const ci = parseInt(attrs.match(/ci="(\d+)"/)?.[1] ?? "0", 10); // covered instructions
      const mi = parseInt(attrs.match(/mi="(\d+)"/)?.[1] ?? "0", 10); // missed instructions
      const cb = parseInt(attrs.match(/cb="(\d+)"/)?.[1] ?? "0", 10); // covered branches
      const mb = parseInt(attrs.match(/mb="(\d+)"/)?.[1] ?? "0", 10); // missed branches

      if (nr > 0) {
        total++;
        const branchesTotal = cb + mb;
        const branchesCovered = cb;
        let status: LineCoverageStatus = "uncovered";
        if (ci > 0 && mb === 0) {
          status = "covered";
          covered++;
        } else if (ci > 0 && mb > 0) {
          status = "partial";
          covered++;
        }

        lines.set(nr, {
          line: nr,
          hits: ci > 0 ? 1 : 0,
          branchesTotal: branchesTotal > 0 ? branchesTotal : undefined,
          branchesCovered: branchesTotal > 0 ? branchesCovered : undefined,
          status,
        });
      }
    }

    if (total > 0) {
      const percentage = Math.round((covered / total) * 100);
      files.set(filename, {
        path: filename,
        linesTotal: total,
        linesCovered: covered,
        percentage,
        lines,
      });
    }
  }

  let totalLines = 0;
  let totalCovered = 0;
  for (const f of files.values()) {
    totalLines += f.linesTotal;
    totalCovered += f.linesCovered;
  }
  const totalPercentage = totalLines > 0 ? Math.round((totalCovered / totalLines) * 100) : 100;

  return {
    timestamp: Date.now(),
    files,
    totalLines,
    totalCovered,
    totalPercentage,
  };
}

/**
 * Auto-detect coverage format (LCOV, JaCoCo, Cobertura) and parse it.
 */
export function parseCoverageReport(content: string): WorkspaceCoverageReport {
  const trimmed = content.trim();
  if (trimmed.startsWith("<?xml") || trimmed.startsWith("<report") || trimmed.includes("<sourcefile")) {
    return parseJacocoXmlCoverage(trimmed);
  }
  return parseLcovCoverage(trimmed);
}

/**
 * Match a target file path against coverage report paths.
 */
export function findFileCoverage(
  report: WorkspaceCoverageReport | null,
  targetPath: string,
): FileCoverage | null {
  if (!report || !targetPath) return null;
  const normalizedTarget = targetPath.replace(/\\/g, "/");

  // Direct match
  const direct = report.files.get(targetPath) || report.files.get(normalizedTarget);
  if (direct) return direct;

  // Suffix match (e.g. coverage has "src/main.ts", target is "/repo/src/main.ts")
  for (const [covPath, fileCov] of report.files) {
    const normCov = covPath.replace(/\\/g, "/");
    if (normalizedTarget.endsWith(normCov) || normCov.endsWith(normalizedTarget)) {
      return fileCov;
    }
    const targetBasename = normalizedTarget.split("/").pop();
    const covBasename = normCov.split("/").pop();
    if (targetBasename && targetBasename === covBasename && (normalizedTarget.includes(normCov) || normCov.includes(normalizedTarget))) {
      return fileCov;
    }
  }

  return null;
}
