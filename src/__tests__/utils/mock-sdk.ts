/**
 * Mock utilities for Anthropic Agent SDK responses.
 * Simulates streaming text, tool calls, and tool results
 * in the Agent SDK event format.
 */

export interface MockStreamOptions {
  text?: string;
  toolCalls?: Array<{ name: string; input: Record<string, unknown> }>;
  toolResults?: Array<{ toolUseId: string; content: string }>;
  thinking?: string;
  costUsd?: number;
  turns?: number;
}

/**
 * Generate a sequence of Agent SDK events matching the real format.
 * Used to test transformToWsEvent and streaming pipeline.
 */
export function generateMockSdkEvents(options: MockStreamOptions): unknown[] {
  const events: unknown[] = [];

  // System init event
  events.push({
    type: "system",
    subtype: "init",
    agent: "claude",
    version: "1.0",
  });

  // Thinking deltas (should be skipped by transformer)
  if (options.thinking) {
    events.push({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: {
          type: "thinking_delta",
          thinking: options.thinking,
        },
      },
    });
  }

  // Text deltas (reasoning)
  if (options.text) {
    const words = options.text.split(" ");
    for (const word of words) {
      events.push({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: {
            type: "text_delta",
            text: word + " ",
          },
        },
      });
    }
  }

  // Tool calls
  if (options.toolCalls) {
    for (const toolCall of options.toolCalls) {
      events.push({
        type: "stream_event",
        event: {
          type: "content_block_start",
          content_block: {
            type: "tool_use",
            id: `tool_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            name: toolCall.name,
            input: toolCall.input,
          },
        },
      });
    }
  }

  // Tool results (via assistant message)
  if (options.toolResults) {
    for (const result of options.toolResults) {
      events.push({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: result.toolUseId,
              content: result.content,
            },
          ],
        },
      });
    }
  }

  // Final result
  events.push({
    type: "result",
    subtype: "success",
    result: "Task completed successfully",
    total_cost_usd: options.costUsd ?? 0.01,
    usage: {
      input_tokens: 100,
      output_tokens: 200,
    },
    num_turns: options.turns ?? 1,
  });

  return events;
}
