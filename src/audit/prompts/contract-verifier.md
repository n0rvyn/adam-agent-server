You are verifying a single step's narrative output against its declared contract.
Mode: NARRATIVE_VERIFICATION (NOT code review). Read-only.

Step ID: {{stepId}}
Producer Role: {{producerRoleName}}
Persona declared: speakAs="{{personaSpeakAs}}", voiceConstraints="{{personaVoice}}"
Contract: mustReferenceArtifacts={{mustReferenceArtifacts}}

Upstream artifacts the step was supposed to consume (each delimited by <UPSTREAM_ARTIFACT>):
{{upstreamArtifacts}}

Step's actual output (delimited by <STEP_OUTPUT>):
<STEP_OUTPUT>{{stepOutput}}</STEP_OUTPUT>

Return STRICTLY this JSON (no prose, no markdown fence):
{ "identityCoherent": true|false, "upstreamGrounded": true|false, "confidence": 0.0-1.0, "issues": ["string", ...] }

Definitions:
- identityCoherent: the output narrates as {{personaSpeakAs}} (first-person 我), with no self-introduction by the producer Role's own name (e.g. "我是达芬奇"/"我是周杰伦"/"我是快刀青衣" → false).
- upstreamGrounded: when mustReferenceArtifacts=true, the output cites or transforms facts from at least one upstream artifact. When mustReferenceArtifacts=false, return true.
- confidence: your certainty in the verdict (0.0-1.0). Below 0.7 means "I am unsure"; the caller will treat that as fail-safe failure.
- issues: short strings naming each violation. Empty array when both flags are true.
