import { describe, expect, it } from "vitest";
import { AuditUnavailableError, auditSummary, runTool, type ToolAudit } from "./run.js";
import { toolByName } from "./tools.js";
import { ToolInputError, type ToolContext } from "./types.js";

const context: ToolContext = {
  operator: "spec",
  project: "spec-project",
  ops: async () => ({ ok: true }),
  scheduler: async () => ({ ok: true }),
  auditRecent: async () => []
};

function recordingAudit(failIntent = false) {
  const rows: string[] = [];
  const audit: ToolAudit = {
    async intent(tool, summary) {
      if (failIntent) throw new Error("audit down");
      rows.push(`intent:${tool}:${summary}`);
    },
    async finish(tool, decision, ok, status) {
      rows.push(`finish:${tool}:${decision}:${ok}:${status}`);
    }
  };
  return { rows, audit };
}

describe("runTool", () => {
  it("writes the intent row before a decision and the outcome after", async () => {
    const { rows, audit } = recordingAudit();
    await runTool(toolByName("wake")!, { agentId: "promoter" }, context, audit);
    expect(rows).toEqual([
      'intent:wake:{"agentId":"promoter"}',
      "finish:wake:true:true:200"
    ]);
  });

  it("refuses a decision when the audit write fails", async () => {
    const { rows, audit } = recordingAudit(true);
    await expect(
      runTool(toolByName("wake")!, { agentId: "promoter" }, context, audit)
    ).rejects.toBeInstanceOf(AuditUnavailableError);
    expect(rows).toEqual([]);
  });

  it("does not write an intent row for reads", async () => {
    const { rows, audit } = recordingAudit();
    await runTool(toolByName("agents_list")!, {}, context, audit);
    expect(rows).toEqual(["finish:agents_list:false:true:200"]);
  });

  it("rejects invalid input with a named error before any audit row", async () => {
    const { rows, audit } = recordingAudit();
    await expect(
      runTool(toolByName("wake")!, { agentId: "NOT VALID" }, context, audit)
    ).rejects.toBeInstanceOf(ToolInputError);
    expect(rows).toEqual([]);
  });

  it("never lets a secret value into an audit summary", () => {
    const summary = auditSummary({
      worker: "scheduler",
      name: "NOTIFY_TOKEN",
      value: "hunter2-super-secret"
    });
    expect(summary).not.toContain("hunter2");
    expect(summary).toContain("[redacted]");
  });

  it("records the failure status on a failing handler", async () => {
    const failing: ToolContext = {
      ...context,
      scheduler: async () => {
        throw new ToolInputError("unknown_agent", 404);
      }
    };
    const { rows, audit } = recordingAudit();
    await expect(
      runTool(toolByName("wake")!, { agentId: "ghost" }, failing, audit)
    ).rejects.toBeInstanceOf(ToolInputError);
    expect(rows[1]).toBe("finish:wake:true:false:404");
  });
});
