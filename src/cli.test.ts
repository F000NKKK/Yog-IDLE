import { describe, expect, it } from "vitest";
import { getDiagnostics } from "substrate-platform-ui";
import { cli, ServiceError } from "./cli";
import { dataProblem, serveMethod } from "./data/yogIds.generated";
import { pathText } from "./diagnostics/yogDiagnostic";

describe("the CLI service's errors", () => {
  it("come typed, and stay in the Error List until the call succeeds", async () => {
    const failed = await cli(serveMethod.DATA_PARSE, { text: "{ a: }" }).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(ServiceError);
    const e = failed as ServiceError;
    expect(e.method).toBe(serveMethod.DATA_PARSE);
    expect(e.problems[0].line).toBe(1);
    expect(e.message).toMatch(/^1:/);
    expect(e.problems[0].code).toBe(dataProblem.SYNTAX);
    const ours = () => getDiagnostics().filter((d) => d.tool?.endsWith(serveMethod.DATA_PARSE));
    expect(ours().some((d) => d.code === dataProblem.SYNTAX && d.line === 1)).toBe(true);
    await cli(serveMethod.DATA_PARSE, { text: "{ a: 1 }" });
    expect(ours()).toEqual([]);
  });

  it("say which parameter is wrong", async () => {
    const e = (await cli(serveMethod.CONTENT_TEXTURE, { path: "/nowhere/a.yblock", texture: "@item:stick" }).catch((x: unknown) => x)) as ServiceError;
    expect(pathText(e.problems[0].path ?? [])).toBe("texture");
    expect(e.problems[0].code).toBe(dataProblem.WRONG_KIND);
    expect(e.file).toBe("/nowhere/a.yblock");
  });
});
