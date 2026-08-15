import { describe, expect, it } from "vitest";
import {
  findFileCoverage,
  parseCoverageReport,
  parseJacocoXmlCoverage,
  parseLcovCoverage,
} from "./coverageModel";

describe("coverageModel", () => {
  it("parses LCOV format coverage with lines and branches", () => {
    const lcov = `
TN:
SF:src/utils.ts
DA:1,3
DA:2,3
DA:3,0
BRDA:2,0,0,1
BRDA:2,0,1,0
LF:3
LH:2
end_of_record
SF:src/service.ts
DA:10,1
DA:11,1
LF:2
LH:2
end_of_record
`;

    const report = parseLcovCoverage(lcov);
    expect(report.totalLines).toBe(5);
    expect(report.totalCovered).toBe(4);
    expect(report.totalPercentage).toBe(80);

    const utils = report.files.get("src/utils.ts");
    expect(utils).toBeDefined();
    expect(utils?.linesTotal).toBe(3);
    expect(utils?.linesCovered).toBe(2);
    expect(utils?.percentage).toBe(67);
    expect(utils?.lines.get(1)?.status).toBe("covered");
    expect(utils?.lines.get(2)?.status).toBe("partial");
    expect(utils?.lines.get(3)?.status).toBe("uncovered");
  });

  it("parses JaCoCo XML format coverage", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<report name="demo">
  <package name="com/example">
    <sourcefile name="DemoService.java">
      <line nr="5" mi="0" ci="1" mb="0" cb="0"/>
      <line nr="6" mi="0" ci="1" mb="1" cb="1"/>
      <line nr="7" mi="1" ci="0" mb="0" cb="0"/>
    </sourcefile>
  </package>
</report>`;

    const report = parseJacocoXmlCoverage(xml);
    expect(report.totalLines).toBe(3);
    expect(report.totalCovered).toBe(2);

    const demo = report.files.get("DemoService.java");
    expect(demo).toBeDefined();
    expect(demo?.lines.get(5)?.status).toBe("covered");
    expect(demo?.lines.get(6)?.status).toBe("partial");
    expect(demo?.lines.get(7)?.status).toBe("uncovered");
  });

  it("matches files with absolute and relative paths", () => {
    const lcov = `
SF:src/main.ts
DA:1,1
end_of_record
`;
    const report = parseCoverageReport(lcov);
    expect(findFileCoverage(report, "/repo/src/main.ts")?.path).toBe("src/main.ts");
    expect(findFileCoverage(report, "src\\main.ts")?.path).toBe("src/main.ts");
    expect(findFileCoverage(report, "/repo/other.ts")).toBeNull();
  });
});
