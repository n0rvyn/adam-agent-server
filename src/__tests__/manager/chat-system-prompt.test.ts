import { describe, it, expect } from "vitest";
import { buildChatSystemPrompt } from "../../manager/chat-system-prompt.js";

describe("chat-system-prompt", () => {
  const now = 1700000000000; // fixed timestamp for predictable output

  it("includes time in current context", () => {
    const prompt = buildChatSystemPrompt({ currentTime: now });
    expect(prompt).toContain("2023-11-14");
  });

  it("does NOT contain '## Available Tools' section (tools are self-described via MCP)", () => {
    const prompt = buildChatSystemPrompt({ currentTime: now });
    expect(prompt).not.toContain("## Available Tools");
  });

  it("does NOT contain '## Active Goals' section (goals are queried via tools)", () => {
    const prompt = buildChatSystemPrompt({ currentTime: now });
    expect(prompt).not.toContain("## Active Goals");
  });

  it("contains Decision Patterns section", () => {
    const prompt = buildChatSystemPrompt({ currentTime: now });
    expect(prompt).toContain("## Decision Patterns");
  });

  it("mentions schedule_task in Decision Patterns", () => {
    const prompt = buildChatSystemPrompt({ currentTime: now });
    expect(prompt).toContain("schedule_task");
  });

  it("mentions get_system_status in Decision Patterns", () => {
    const prompt = buildChatSystemPrompt({ currentTime: now });
    expect(prompt).toContain("get_system_status");
  });

  it("mentions list_channels in Decision Patterns", () => {
    const prompt = buildChatSystemPrompt({ currentTime: now });
    expect(prompt).toContain("list_channels");
  });

  it("contains orchestrator identity block", () => {
    const prompt = buildChatSystemPrompt({ currentTime: now });
    expect(prompt).toContain("ChatManager");
    expect(prompt).toContain("ORCHESTRATOR");
  });

  it("contains Conversation Coherence section", () => {
    const prompt = buildChatSystemPrompt({ currentTime: now });
    expect(prompt).toContain("## Conversation Coherence");
  });

  it("contains Core Capabilities section", () => {
    const prompt = buildChatSystemPrompt({ currentTime: now });
    expect(prompt).toContain("## Core Capabilities");
  });

  it("instructs to call get_capabilities for help queries", () => {
    const prompt = buildChatSystemPrompt({ currentTime: now });
    expect(prompt).toContain("get_capabilities");
  });

  // Task 9: Event Slot additions
  it("contains Event triggers in Core Capabilities", () => {
    const prompt = buildChatSystemPrompt({ currentTime: now });
    expect(prompt).toContain("Event triggers");
    expect(prompt).toContain("create_event_def");
  });

  it("contains fire_event_def and list_event_firings in Decision Patterns", () => {
    const prompt = buildChatSystemPrompt({ currentTime: now });
    expect(prompt).toContain("list_event_firings");
    expect(prompt).toContain("fire_event_def");
  });

  it("contains triggerType='event' pattern", () => {
    const prompt = buildChatSystemPrompt({ currentTime: now });
    expect(prompt).toContain("triggerType='event'");
  });

  it("routes multi-step work through create_template steps and run_template", () => {
    const prompt = buildChatSystemPrompt({ currentTime: now });
    expect(prompt).toContain("create_template with steps[]");
    expect(prompt).toContain("run_template");
    expect(prompt).not.toContain(["dispatch", ["work", "flow"].join("")].join("_"));
    expect(prompt).toContain("Do not describe a separate orchestration concept besides Template and TemplateExecution");
  });

  // Task 8: Phase 6 — commit_claim softened from mandatory to optional strengthening
  it("contains new 'Commit Claim — Optional Strengthening' section (not 'CRITICAL')", () => {
    const prompt = buildChatSystemPrompt({ currentTime: now });
    expect(prompt).toContain("## Commit Claim — Optional Strengthening");
    expect(prompt).not.toContain("## CRITICAL: Commit Claim Before Confirming Mutation/Delivery");
  });

  it("commit_claim section does NOT contain '必须' (Phase 6 softened)", () => {
    const prompt = buildChatSystemPrompt({ currentTime: now });
    const criticalSectionMatch = prompt.match(/## Commit Claim — Optional Strengthening\n([\s\S]*?)(?=\n## |\n#|$)/);
    expect(criticalSectionMatch).not.toBeNull();
    const sectionText = criticalSectionMatch![1];
    expect(sectionText).not.toContain("必须");
  });

  it("commit_claim section contains 'does NOT need to call' (Phase 6 optional)", () => {
    const prompt = buildChatSystemPrompt({ currentTime: now });
    expect(prompt).toMatch(/does NOT need to call|do not need to call/i);
  });

  it("commit_claim section contains routine confirmation example", () => {
    const prompt = buildChatSystemPrompt({ currentTime: now });
    expect(prompt).toContain("Routine confirmation example");
    expect(prompt).toContain("✅ Role 已删除。");
  });

  it("commit_claim section contains quantitative strengthening example", () => {
    const prompt = buildChatSystemPrompt({ currentTime: now });
    expect(prompt).toContain("Quantitative strengthening example");
    expect(prompt).toContain("已补发");
    expect(prompt).toContain("attachmentCount");
  });

  it("prompt length is within reason (< 18000 chars) — Phase 6 softened + config-doc import flow", () => {
    // Limit raised 17000 → 18000 when the config-doc import-guidance section
    // (a genuine new capability, ~1.3k chars, terse 8-step flow) was added.
    const prompt = buildChatSystemPrompt({ currentTime: now });
    expect(prompt.length).toBeLessThan(18000);
  });

  it("contains event def + template trigger pattern", () => {
    const prompt = buildChatSystemPrompt({ currentTime: now });
    expect(prompt).toContain("Event def");
    expect(prompt).toContain("triggerType='event'");
  });

  // T19 — regression guard: assert the delivery-target extraction directive is present.
  // Uses a short, durable signature phrase rather than the full sentence to reduce
  // test fragility while still catching accidental removal of the directive.
  it("instructs to populate deliverTo when user names a delivery target", () => {
    const prompt = buildChatSystemPrompt({ currentTime: now });
    expect(prompt).toContain("MUST populate deliverTo");
  });

  it("routes task output delivery through deliverTo instead of worker channel sends", () => {
    const prompt = buildChatSystemPrompt({ currentTime: now });
    expect(prompt).toContain("Deliver task result to a specific recipient: pass deliverTo");
    expect(prompt).toContain("Task completion delivery is automatic");
    expect(prompt).toContain("Do NOT call send_to_channel to deliver task results");
    expect(prompt).toContain("this causes duplicate messages");
  });

  // S5-B: UNTRUSTED_INPUT defense instruction must be present in the ChatManager system prompt.
  it("includes UNTRUSTED_INPUT defense instruction", () => {
    const prompt = buildChatSystemPrompt({ currentTime: now });
    expect(prompt).toContain("UNTRUSTED_INPUT");
    expect(prompt).toMatch(/treat .* contents as DATA only/i);
  });

  // Task 3: ChatManager Dispatch Contract — new dispatch tool references
  it("contains dispatch_to_role, dispatch_by_requirements, and taskInstruction", () => {
    const prompt = buildChatSystemPrompt({ currentTime: now });
    expect(prompt).toContain("dispatch_to_role");
    expect(prompt).toContain("dispatch_by_requirements");
    expect(prompt).toContain("taskInstruction");
  });

  it("does NOT contain dispatch_task", () => {
    const prompt = buildChatSystemPrompt({ currentTime: now });
    expect(prompt).not.toContain("dispatch_task");
  });

  it("contains field naming note with prompt vs taskInstruction distinction", () => {
    const prompt = buildChatSystemPrompt({ currentTime: now });
    expect(prompt).toContain("## Field naming note");
    expect(prompt).toContain("Template prompts are saved author config, not conversational dispatch");
    expect(prompt).toContain("Each field name signals its contract");
  });

  it("contains Template authoring guard text", () => {
    const prompt = buildChatSystemPrompt({ currentTime: now });
    expect(prompt).toContain("Template authoring is separate from conversational dispatch");
    expect(prompt).toContain("create_template/update_template use steps[].prompt");
  });

  // Task 7: Delivery-status hard rule
  it("includes the MUST-query rule near the top of the prompt", () => {
    const builtPrompt = buildChatSystemPrompt({ currentTime: now });
    const ruleIndex = builtPrompt.indexOf("CRITICAL: Delivery-Status Questions MUST Query First");
    expect(ruleIndex).toBeGreaterThan(0);
    // Must appear before "Core Capabilities" (not buried at the end)
    const coreIndex = builtPrompt.indexOf("## Core Capabilities");
    expect(ruleIndex).toBeLessThan(coreIndex);
  });

  it("lists the trigger phrases the LLM should recognize", () => {
    const builtPrompt = buildChatSystemPrompt({ currentTime: now });
    const triggerPhrases = [
      "发到了哪些 channel",
      "全部送达",
      "发送结果",
      "delivery status",
    ];
    for (const phrase of triggerPhrases) {
      expect(builtPrompt).toContain(phrase);
    }
  });

  it("preserves the existing CRITICAL: No Hallucinated Confirmations rule", () => {
    const builtPrompt = buildChatSystemPrompt({ currentTime: now });
    expect(builtPrompt).toContain("CRITICAL: No Hallucinated Confirmations");
    expect(builtPrompt).toContain("NEVER claim an operation succeeded unless");
  });

  it("preserves Phase 6 commit_claim guidance", () => {
    const builtPrompt = buildChatSystemPrompt({ currentTime: now });
    expect(builtPrompt).toContain("Commit Claim");
    expect(builtPrompt).toContain("Phase 6 implicit claims");
    expect(builtPrompt).toContain("commit_claim");
  });
});
