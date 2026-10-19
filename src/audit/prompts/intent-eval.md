# Intent Fulfillment Evaluation

You are evaluating how well a completed task fulfilled the user's original intent.

## Inputs

**User's original request** (from chat):
{{userRequest}}

**Role identity** (the worker that handled this task):
- Name: {{roleName}}
- CAG: {{roleCag}}

**Task result** (what the worker produced):
{{taskResult}}

## Your task

Score the task on a continuous scale from 0.0 to 1.0:
- **1.0** — Task fully satisfies the user's stated intent. Result is complete, correct, and addresses what the user asked for. No major gaps.
- **0.7** — Task largely satisfies intent. Minor gaps or imperfections that don't materially harm the user's goal.
- **0.5** — Task partially satisfies intent. Significant gaps, missing aspects, or partial answers, but some progress.
- **0.3** — Task minimally satisfies intent. Mostly missed the point but contains some relevant content.
- **0.0** — Task does not satisfy intent. Wrong direction, fabricated content, or completely off-topic.

Be strict but fair. Reward solving the actual problem; penalize hand-waving or off-topic responses. Do NOT reward verbosity over substance.

## Output format

Respond with ONLY a JSON object on a single line, no prose, no markdown fences:
{"score": 0.NN, "reason": "one short sentence explaining the score"}
