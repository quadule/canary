import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLogger } from "dailies-logger";
import { describe, expect, it } from "vitest";
import { attachFiles } from "./attach.js";

const log = createLogger({ level: "silent" });

async function fixture(): Promise<{ dir: string; sessionDir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "dailies-attach-"));
  const sessionDir = path.join(dir, "session");
  await mkdir(sessionDir, { recursive: true });
  return { dir, sessionDir };
}

async function file(dir: string, name: string, body = "x"): Promise<string> {
  const p = path.join(dir, name);
  await writeFile(p, body);
  return p;
}

describe("attachFiles", () => {
  it("copies files into attachments/ and reports their names", async () => {
    const { dir, sessionDir } = await fixture();
    const a = await file(dir, "coverage.md", "# coverage");
    const b = await file(dir, "report.zip", "zip");

    const outcome = await attachFiles({ files: [a, b], log, sessionDir });

    expect(outcome).toEqual({
      attached: ["coverage.md", "report.zip"],
      failures: [],
    });
    expect(
      (await readdir(path.join(sessionDir, "attachments"))).sort()
    ).toEqual(["coverage.md", "report.zip"]);
    expect(
      await readFile(
        path.join(sessionDir, "attachments", "coverage.md"),
        "utf8"
      )
    ).toBe("# coverage");
  });

  it("creates attachments/ when it doesn't exist yet", async () => {
    const { dir, sessionDir } = await fixture();
    await attachFiles({ files: [await file(dir, "a.txt")], log, sessionDir });
    expect(await readdir(path.join(sessionDir, "attachments"))).toEqual([
      "a.txt",
    ]);
  });

  it("keeps going after a bad path, and never throws", async () => {
    const { dir, sessionDir } = await fixture();
    const good = await file(dir, "good.md");

    const outcome = await attachFiles({
      files: [path.join(dir, "nope.md"), good],
      log,
      sessionDir,
    });

    // Losing the whole report over one bad path would be the worse outcome.
    expect(outcome.attached).toEqual(["good.md"]);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]).toContain("nope.md");
  });

  it("skips an empty file, since the artifact scanners drop zero-byte files", async () => {
    const { dir, sessionDir } = await fixture();
    const empty = await file(dir, "empty.md", "");

    const outcome = await attachFiles({ files: [empty], log, sessionDir });

    expect(outcome.attached).toEqual([]);
    expect(outcome.failures[0]).toContain("empty");
    // Nothing copied, rather than a file that silently wouldn't show up.
    expect(await readdir(path.join(sessionDir, "attachments"))).toEqual([]);
  });

  it("rejects a directory rather than copying it", async () => {
    const { dir, sessionDir } = await fixture();
    const sub = path.join(dir, "subdir");
    await mkdir(sub);
    const outcome = await attachFiles({ files: [sub], log, sessionDir });
    expect(outcome.attached).toEqual([]);
    expect(outcome.failures[0]).toContain("not a file");
  });

  it("flattens to the basename, so two dirs' files don't collide by path", async () => {
    const { dir, sessionDir } = await fixture();
    const nested = path.join(dir, "deep", "deeper");
    await mkdir(nested, { recursive: true });
    const f = await file(nested, "coverage.md", "nested");
    await attachFiles({ files: [f], log, sessionDir });
    expect(await readdir(path.join(sessionDir, "attachments"))).toEqual([
      "coverage.md",
    ]);
  });

  it("does nothing at all for an empty file list", async () => {
    const { sessionDir } = await fixture();
    const outcome = await attachFiles({ files: [], log, sessionDir });
    expect(outcome).toEqual({ attached: [], failures: [] });
    // Doesn't even create the directory — nothing to put in it.
    await expect(
      readdir(path.join(sessionDir, "attachments"))
    ).rejects.toThrow();
  });
});
