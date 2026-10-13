import AsyncStorage from '@react-native-async-storage/async-storage';
import mobileAds, { AdEventType, InterstitialAd, TestIds } from 'react-native-google-mobile-ads';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

type Topic = 'Architecture' | 'Prompting & context' | 'Tools & agents' | 'Safety & operations';
type Mode = 'timed' | 'study';
type Screen = 'home' | 'exam' | 'results';

type Source = {
  title: string;
  section?: string;
  url: string;
  quote: string;
};

type Question = {
  id: number;
  topic: Topic;
  prompt: string;
  options: string[];
  answer: number;
  explanation: string;
  source: Source;
};

type AttemptResult = {
  score: number;
  correct: number;
  total: number;
  topic: string;
  completedAt: string;
};

const RESULT_STORAGE_KEY = 'fieldnotes.latestAttempt';
const QUESTIONS_PER_AD = 10;
const AD_LOAD_TIMEOUT_MS = 8000;
const INTERSTITIAL_AD_UNIT_ID = __DEV__
  ? TestIds.INTERSTITIAL
  : process.env.EXPO_PUBLIC_ADMOB_INTERSTITIAL_ID;

const QUESTIONS: Question[] = [
  {
    id: 1,
    topic: 'Architecture',
    prompt: 'A support assistant must answer questions using a large, frequently updated knowledge base. What is the strongest starting architecture?',
    options: [
      'Load the full knowledge base into a cached system prompt so every answer can draw on all of it',
      'Retrieve relevant, permission-filtered passages and provide them as context',
      'Fine-tune the model on the knowledge base and retrain after each update',
      'Let the model answer from training data and link to the help center',
    ],
    answer: 1,
    explanation: 'Retrieval-augmented generation keeps answers grounded in current source material without repeatedly sending the whole corpus. Apply access controls before retrieved content reaches the model.',
    source: {
      title: 'Anthropic Engineering: Introducing Contextual Retrieval',
      url: 'https://www.anthropic.com/engineering/contextual-retrieval',
      quote: 'RAG is a method that retrieves relevant information from a knowledge base and appends it to the user\'s prompt, significantly enhancing the model\'s response.',
    },
  },
  {
    id: 2,
    topic: 'Prompting & context',
    prompt: 'An application prompt includes retrieved documents that may contain instructions. How should those documents be treated?',
    options: [
      'As trusted context, since the documents come from company-controlled storage',
      'As untrusted reference data, clearly separated from system instructions',
      'As instructions only when they come from a document the user uploaded themselves',
      'As trusted once a keyword filter has removed phrases like "ignore previous instructions"',
    ],
    answer: 1,
    explanation: 'Retrieved text is data, not authority. Delimit it and instruct the model to use it as evidence rather than follow embedded commands. Keep authorization and tool policy in trusted application logic.',
    source: {
      title: 'Claude Docs: Mitigate jailbreaks and prompt injections',
      section: 'Indirect prompt injection',
      url: 'https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks#indirect-prompt-injection',
      quote: 'Tell Claude explicitly that content returned from tools, documents, or searches is untrusted data and must never override the system prompt or the user\'s original request.',
    },
  },
  {
    id: 3,
    topic: 'Tools & agents',
    prompt: 'A model proposes issuing a refund through a write-enabled tool. What should the application do before executing it?',
    options: [
      'Execute it if the arguments pass JSON schema validation',
      "Check the arguments and the user's authorization, and get approval if policy requires it",
      'Ask the model to restate its reasoning, and execute only if it still agrees',
      'Execute it and log the call so finance can reverse any mistakes during the weekly audit',
    ],
    answer: 1,
    explanation: 'The application owns authorization and side-effect policy. Validate the requested action against the user and business rules; use a human confirmation step for consequential actions where appropriate.',
    source: {
      title: 'OWASP Top 10 for LLM Applications: LLM06:2025 Excessive Agency',
      section: 'Complete mediation',
      url: 'https://genai.owasp.org/llmrisk/llm062025-excessive-agency/',
      quote: 'Enforce the complete mediation principle so that all requests made to downstream systems via extensions are validated against security policies.',
    },
  },
  {
    id: 4,
    topic: 'Safety & operations',
    prompt: 'A prompt change improves a few hand-picked examples but may affect other workflows. What is the best release check?',
    options: [
      'Ship it, since the hand-picked examples cover the most common requests',
      'Run a representative eval set and compare quality and safety with the baseline',
      'Release it to all users and roll back if complaints rise above the normal level',
      'Have a second model judge whether the new prompt is clearer than the old one',
    ],
    answer: 1,
    explanation: 'A repeatable evaluation set makes regressions visible across known cases. Track task-specific quality and safety measures, then use human review for judgments that automated metrics cannot reliably capture.',
    source: {
      title: 'Claude Docs: Define success criteria and build evaluations',
      section: 'Eval design principles',
      url: 'https://platform.claude.com/docs/en/test-and-evaluate/develop-tests#eval-design-principles',
      quote: 'Be task-specific: Design evals that mirror your real-world task distribution. Don\'t forget to factor in edge cases!',
    },
  },
  {
    id: 5,
    topic: 'Architecture',
    prompt: 'A workflow has a straightforward classification step with strict latency and cost limits. Which approach should you evaluate first?',
    options: [
      'The most capable model, so quality is never the limiting factor',
      'A smaller, faster model, checked against a representative eval set',
      'A pipeline where a second model reviews every classification before it is returned',
      'A fine-tuned model, trained before any baseline results are collected',
    ],
    answer: 1,
    explanation: 'Choose the least complex option that meets quality requirements. Benchmark a smaller model on representative examples, and escalate only when measured quality requires it.',
    source: {
      title: 'Claude Docs: Choosing a model',
      section: 'Option 1: Start efficiency-first',
      url: 'https://platform.claude.com/docs/en/about-claude/models/choosing-a-model#option-1-start-efficiency-first',
      quote: 'For many applications, starting with a faster, more cost-effective model like Claude Haiku 5.5 can be the optimal approach',
    },
  },
  {
    id: 6,
    topic: 'Prompting & context',
    prompt: 'A long-running conversation is nearing the model context limit. Which response best preserves continuity?',
    options: [
      'Drop the oldest messages automatically, keeping only the most recent turns',
      'Summarize decisions and open tasks, then continue with recent context',
      'Switch to a model with a larger context window and keep sending everything',
      'Raise max_tokens so the model has room to keep the whole conversation in view',
    ],
    answer: 1,
    explanation: 'A deliberate summary can preserve decisions, constraints, and open tasks while controlling context growth. Keep source references or exact values when the workflow depends on them. Note that max_tokens limits output, not context.',
    source: {
      title: 'Claude Docs: Compaction',
      url: 'https://platform.claude.com/docs/en/build-with-claude/compaction',
      quote: 'Compaction replaces the older turns of a conversation with a summary that Claude writes on the server, so you need no summarization code of your own.',
    },
  },
  {
    id: 7,
    topic: 'Tools & agents',
    prompt: 'The application needs machine-readable model output that conforms to a known shape. What is the most reliable design?',
    options: [
      'Ask for JSON in the prompt and include an example of the expected format',
      'Use structured outputs and still validate the result in the app',
      'Parse the fields out of a natural-language answer with regular expressions',
      'Ask for JSON, and retry with a higher temperature whenever parsing fails',
    ],
    answer: 1,
    explanation: 'Constrained structured output can improve format reliability, but application-side validation is still important. Handle refusals, incomplete responses, and schema mismatches explicitly.',
    source: {
      title: 'Claude Docs: Structured outputs',
      url: 'https://platform.claude.com/docs/en/build-with-claude/structured-outputs',
      quote: 'Without structured outputs, Claude can generate malformed JSON responses or invalid tool inputs that break your applications.',
    },
  },
  {
    id: 8,
    topic: 'Safety & operations',
    prompt: 'A client retries a request after a network timeout, but the first attempt may already have created a support ticket. What reduces duplicate side effects?',
    options: [
      'Retry immediately with the same payload, since a timeout usually means the request failed',
      'Send an idempotency key so the service can recognize the repeat',
      'Ask the model whether it already created a ticket in this conversation',
      'Search for a ticket with a similar subject before retrying',
    ],
    answer: 1,
    explanation: 'Idempotency lets the service recognize a repeated operation and return the original outcome instead of performing the side effect twice. Searching first is racy and unreliable. Define retry limits and observable failure states too.',
    source: {
      title: 'Stripe API Reference: Idempotent requests',
      url: 'https://docs.stripe.com/api/idempotent_requests',
      quote: 'The API supports idempotency for safely retrying requests without accidentally performing the same operation twice.',
    },
  },
  {
    id: 9,
    topic: 'Safety & operations',
    prompt: "A document retrieved for a user contains text attempting to override the assistant's instructions. What is the primary control?",
    options: [
      'A system prompt line telling the model to ignore instructions inside documents',
      'Treat it as untrusted and enforce tool permissions outside the model',
      'A classifier on retrieved text, trusting any document it marks as safe',
      'A higher retrieval score threshold, so fewer suspicious documents are returned',
    ],
    answer: 1,
    explanation: 'Prompt injection can arrive through retrieved content. Prompt instructions and filters help but can be bypassed; critical protections belong in application policy: restrict tools, scope credentials, validate actions, and monitor outcomes.',
    source: {
      title: 'OWASP Cheat Sheet: LLM Prompt Injection Prevention',
      section: 'Agent-Specific Defenses',
      url: 'https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html#agent-specific-defenses',
      quote: 'For LLM agents with tool access: Validate tool calls against user permissions and session context … Restrict tool access based on principle of least privilege',
    },
  },
  {
    id: 10,
    topic: 'Architecture',
    prompt: 'A production assistant becomes slower and more expensive after launch. Which telemetry best helps locate the cause?',
    options: [
      'Total request count and average end-to-end latency per day',
      'Per-stage latency, token usage, model, retries, and task success',
      'The full text of every prompt and response, kept indefinitely for review',
      'Error rates from the mobile client, grouped by app version and device',
    ],
    answer: 1,
    explanation: 'Correlated, privacy-conscious telemetry by workflow stage helps distinguish model latency, oversized context, retries, and downstream delays. Pair efficiency measures with task-success and safety outcomes.',
    source: {
      title: 'OpenTelemetry: Semantic conventions for generative AI metrics',
      section: 'Generative AI client metrics',
      url: 'https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-metrics.md#generative-ai-client-metrics',
      quote: 'The following metric instruments describe Generative AI operations. An operation may be a request to an LLM, a function call, or some other distinct action within a larger Generative AI workflow.',
    },
  },
  {
    id: 11,
    topic: 'Tools & agents',
    prompt: 'When is an agentic loop with tool use most justified?',
    options: [
      'Whenever the task can be described in a single prompt',
      'When the task needs several decisions or external actions, with clear limits',
      'Whenever the input is too long to fit into a single request',
      'When the steps are fixed and known in advance, so the agent can follow them reliably',
    ],
    answer: 1,
    explanation: 'An agent loop adds capability but also latency, cost, and failure modes. Use it when iterative decisions or tools are necessary, and bound steps, permissions, time, and stopping conditions. Fixed, known steps are better as a workflow in code.',
    source: {
      title: 'Anthropic Engineering: Building effective agents',
      section: 'When (and when not) to use agents',
      url: 'https://www.anthropic.com/engineering/building-effective-agents',
      quote: 'When building applications with LLMs, we recommend finding the simplest solution possible, and only increasing complexity when needed. This might mean not building agentic systems at all.',
    },
  },
  {
    id: 12,
    topic: 'Prompting & context',
    prompt: 'A prompt must consistently return a concise support response with required fields. What is the best first refinement?',
    options: [
      'Add many examples of good responses, covering every type of request',
      'State the task, constraints, and output structure, then test real cases',
      'Tell the model in capital letters that it must ALWAYS include every field',
      'Set the temperature to zero, which guarantees the same structure every time',
    ],
    answer: 1,
    explanation: 'Clear task instructions and an explicit output structure make expectations easier to follow and evaluate. Test both routine and edge cases before relying on the behavior in production.',
    source: {
      title: 'Claude Docs: Prompting best practices',
      section: 'Be clear and direct',
      url: 'https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices#be-clear-and-direct',
      quote: 'Claude responds well to clear, explicit instructions. Being specific about your desired output can help enhance results.',
    },
  },
  {
    id: 13,
    topic: 'Architecture',
    prompt: 'A mobile app calls a model provider directly and needs an API credential. Where should that credential live?',
    options: [
      'In the app bundle, obfuscated at build time and rotated with every release',
      'On a server that authenticates users and applies quotas before each call',
      'In remote config, fetched after sign-in and stored in the device keychain',
      'In an EXPO_PUBLIC_ environment variable, so it never appears in source control',
    ],
    answer: 1,
    explanation: 'Anything shipped to a client can be extracted, including obfuscated values, remote config, and public build-time variables. Keep provider credentials on a trusted server, authenticate app users there, and enforce rate limits and usage policy before making model calls.',
    source: {
      title: 'Android Developers: Hardcoded cryptographic secrets',
      section: 'Impact',
      url: 'https://developer.android.com/privacy-and-security/risks/hardcoded-cryptographic-secrets#impact',
      quote: 'An attacker with access to reverse engineering tools can retrieve a hard-coded secret very easily.',
    },
  },
  {
    id: 14,
    topic: 'Prompting & context',
    prompt: 'Two retrieved policy passages disagree. Each includes an owner and an effective date. How should the assistant handle the conflict?',
    options: [
      'Prefer the newer passage from the authoritative owner, and flag any remaining doubt',
      'Merge both passages so the user sees every rule that might apply',
      'Prefer the passage that ranked higher in retrieval',
      'Ask the model to decide which passage sounds more reasonable, and answer from that one',
    ],
    answer: 0,
    explanation: 'Source authority and freshness should determine which information applies. Preserve metadata during retrieval, and abstain or escalate if the conflict cannot be resolved reliably.',
    source: {
      title: 'Claude Docs: Reduce hallucinations',
      section: 'Basic hallucination minimization strategies',
      url: 'https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-hallucinations#basic-hallucination-minimization-strategies',
      quote: 'Allow Claude to say "I don\'t know": Explicitly give Claude permission to admit uncertainty. This simple technique can drastically reduce false information.',
    },
  },
  {
    id: 15,
    topic: 'Tools & agents',
    prompt: 'A tool call includes a tenant ID selected by the model. What must happen before the tool reads tenant data?',
    options: [
      "Nothing extra, because the model took the ID from the user's own message",
      'Check that the tenant exists and is active, then allow access',
      "Check it against the authenticated user's allowed tenants in server code",
      'Ask the model to confirm the user belongs to that tenant before calling the tool',
    ],
    answer: 2,
    explanation: 'The model is not an authorization boundary. Derive identity from the authenticated session and verify every requested resource against server-side access policy.',
    source: {
      title: 'OWASP Cheat Sheet: Insecure Direct Object Reference Prevention',
      section: 'Introduction',
      url: 'https://cheatsheetseries.owasp.org/cheatsheets/Insecure_Direct_Object_Reference_Prevention_Cheat_Sheet.html#introduction',
      quote: 'It occurs due to missing access control checks, which fail to verify whether a user should be allowed to access specific data.',
    },
  },
  {
    id: 16,
    topic: 'Safety & operations',
    prompt: 'A team needs request traces to debug answer quality, but prompts may contain personal data. What is the best logging approach?',
    options: [
      'Log full prompts, but restrict the trace dashboard to the engineering team',
      'Redact sensitive fields, restrict access, and set a retention period',
      'Log nothing from prompts and rely on user bug reports to find quality problems',
      'Hash each prompt so it can be stored indefinitely without exposing personal data',
    ],
    answer: 1,
    explanation: 'Observability should be proportionate to the debugging need. Reduce sensitive content, apply access controls and retention limits, and continue collecting operational metrics that do not require raw personal data. Hashed prompts cannot be read, so they do not help debug quality.',
    source: {
      title: 'OWASP Cheat Sheet: Logging',
      section: 'Data to exclude',
      url: 'https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html#data-to-exclude',
      quote: 'The following should usually not be recorded directly in the logs, but instead should be removed, masked, sanitized, hashed, or encrypted: … Sensitive personal data',
    },
  },
  {
    id: 17,
    topic: 'Architecture',
    prompt: 'A retrieval index can lag behind updates to the source policy. Which design best handles freshness?',
    options: [
      'Rebuild the whole index every night and assume it is current during the day',
      'Tell the model in the system prompt to prefer the most recent documents',
      'Use smaller chunks so updated sections are more likely to be retrieved',
      'Track index freshness; reindex or check the source when content is stale',
    ],
    answer: 3,
    explanation: 'Retrieval relevance does not guarantee freshness. Track source versions and indexing delay, then refresh or consult the authoritative source when freshness matters to the answer.',
    source: {
      title: 'TianPan.co (blog): RAG Knowledge Base Freshness: The Staleness Problem Teams Solve Last',
      url: 'https://tianpan.co/blog/2026-04-20-rag-knowledge-base-freshness-index-rot',
      quote: 'Unlike retrieval quality failures that show up immediately in evals, staleness degrades silently: latency stays flat, retrieval appears functional … right up until the moment your system confidently returns a policy that was updated months ago.',
    },
  },
  {
    id: 18,
    topic: 'Prompting & context',
    prompt: 'Many requests share the same long system instructions, followed by user-specific data. How can the application reduce repeated input cost when supported?',
    options: [
      'Keep the shared instructions as an unchanged prefix and put user data after them',
      'Put the user data first so the model reads it before the instructions',
      'Summarize the shared instructions on each request so they are shorter',
      'Add the current time at the top of the instructions so cached entries stay fresh',
    ],
    answer: 0,
    explanation: 'A stable, reusable prompt prefix can be eligible for provider prompt caching. Keep dynamic data, including timestamps, after it, and measure actual cache behavior rather than assuming every request is a cache hit.',
    source: {
      title: 'Claude Docs: Prompt caching',
      section: 'Structuring your prompt',
      url: 'https://platform.claude.com/docs/en/build-with-claude/prompt-caching#structuring-your-prompt',
      quote: 'For a prompt with a varying suffix (timestamps, per-request context, the incoming message), place the breakpoint at the end of the static prefix, not on the varying block.',
    },
  },
  {
    id: 19,
    topic: 'Tools & agents',
    prompt: 'A workflow always follows the same sequence: validate a request, look up an account, request approval, then save an update. Which orchestration is the best starting point?',
    options: [
      'An agent with access to all four tools that decides the order itself',
      'A single prompt asking the model to do all four steps and report back',
      'Fixed steps in application code, using the model only where interpretation is needed',
      'Several specialized agents, one per step, coordinated by a supervisor agent',
    ],
    answer: 2,
    explanation: 'Known workflows benefit from predictable control flow, clear authorization points, and auditable transitions. Reserve agentic decisions for parts of the task that genuinely need flexible reasoning.',
    source: {
      title: 'Anthropic Engineering: Building effective agents',
      section: 'When (and when not) to use agents',
      url: 'https://www.anthropic.com/engineering/building-effective-agents',
      quote: 'When more complexity is warranted, workflows offer predictability and consistency for well-defined tasks, whereas agents are the better option when flexibility and model-driven decision-making are needed at scale.',
    },
  },
  {
    id: 20,
    topic: 'Safety & operations',
    prompt: 'An assistant drafts a recommendation that could trigger a consequential account change. What is the safer initial release design?',
    options: [
      "Apply the change automatically when the model's stated confidence is high",
      'Show the proposed change and require approval by an authorized person',
      'Apply the change and send the user a notification with an undo link',
      'Have a second model review the change, and apply it if both models agree',
    ],
    answer: 1,
    explanation: 'Separate a model-generated recommendation from the consequential side effect. Require approval by an authorized person and revalidate the action in application code before committing it.',
    source: {
      title: 'OWASP Top 10 for LLM Applications: LLM06:2025 Excessive Agency',
      section: 'Require user approval',
      url: 'https://genai.owasp.org/llmrisk/llm062025-excessive-agency/',
      quote: 'Utilise human-in-the-loop control to require a human to approve high-impact actions before they are taken.',
    },
  },
  {
    id: 21,
    topic: 'Architecture',
    prompt: 'A support flow must verify that an order ID matches the signed-in customer before showing order details. Where should that check happen?',
    options: [
      'In server-side authorization code, before any order data is returned',
      'In the system prompt, instructing the model to refuse mismatched orders',
      'In the mobile app, which hides orders that belong to other customers',
      "In a post-processing step that scans the reply for other customers' details",
    ],
    answer: 0,
    explanation: 'Authorization and exact data-integrity checks are deterministic application responsibilities. The model should only receive data the authenticated user is permitted to access.',
    source: {
      title: 'OWASP Cheat Sheet: Authorization',
      section: 'Validate the Permissions on Every Request',
      url: 'https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html#validate-the-permissions-on-every-request',
      quote: 'Permission should be validated correctly on every request, regardless of whether the request was initiated by an AJAX script, server-side, or any other source.',
    },
  },
  {
    id: 22,
    topic: 'Prompting & context',
    prompt: 'A long conversation must be summarized before a new model call. Which information should the summary preserve?',
    options: [
      'Every message verbatim, with only greetings and filler removed',
      'The last few turns, since those are most relevant to the next request',
      'The task, decisions, constraints, open questions, and key sources',
      'A short paragraph about the topic, so the next call has the general idea',
    ],
    answer: 2,
    explanation: 'A useful summary preserves state needed to continue the task while omitting irrelevant history. Keep critical constraints and source references explicit, and do not invent user attributes.',
    source: {
      title: 'Anthropic Engineering: Effective context engineering for AI agents',
      section: 'Compaction',
      url: 'https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents',
      quote: 'The model preserves architectural decisions, unresolved bugs, and implementation details while discarding redundant tool outputs or messages.',
    },
  },
  {
    id: 23,
    topic: 'Tools & agents',
    prompt: 'A model-generated tool call needs to search order records in SQL. Which implementation best limits injection risk?',
    options: [
      'Let the model write the SQL, and run it only if it starts with SELECT',
      'Use a parameterized query with server-side tenant and permission filters',
      'Escape quotes in the model-provided ID before adding it to the SQL string',
      'Ask the model to check its own query for injection before it is executed',
    ],
    answer: 1,
    explanation: 'Treat tool arguments as untrusted input. Parameterize values, scope queries to the authenticated principal, and avoid granting the model or tool broader database access than required.',
    source: {
      title: 'OWASP Cheat Sheet: SQL Injection Prevention',
      section: 'Defense Option 1: Prepared Statements (with Parameterized Queries)',
      url: 'https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html#defense-option-1-prepared-statements-with-parameterized-queries',
      quote: 'If database queries use this coding style, the database will always distinguish between code and data, regardless of what user input is supplied.',
    },
  },
  {
    id: 24,
    topic: 'Safety & operations',
    prompt: 'A new model version appears better on an internal demo. What is the strongest way to decide whether to release it?',
    options: [
      'Switch everyone over, since newer models are generally better at every task',
      'Run the demo again with more examples, and switch if it still looks better',
      "Have the new model grade a sample of its own answers against the old model's",
      'Run versioned evals, roll out gradually, and monitor quality and safety',
    ],
    answer: 3,
    explanation: 'Versioned evaluations reveal regressions across representative cases. A staged rollout with monitoring limits impact and makes rollback possible if production behavior differs from offline results.',
    source: {
      title: 'Google SRE Workbook: Canarying Releases',
      section: 'Canarying Releases',
      url: 'https://sre.google/workbook/canarying-releases/',
      quote: 'We define canarying as a partial and time-limited deployment of a change in a service and its evaluation. This evaluation helps us decide whether or not to proceed with the rollout.',
    },
  },
  {
    id: 25,
    topic: 'Architecture',
    prompt: 'A user asks an assistant to check payment status. The payment system is temporarily unavailable. What should the assistant do?',
    options: [
      'Show the last known status from earlier in the conversation as current',
      'Tell the user the payment probably went through and to check back later',
      'Say the status is unavailable right now, and use bounded retries',
      'Keep retrying in the background until the payment system responds',
    ],
    answer: 2,
    explanation: 'The source-of-truth system must determine payment state. Fail transparently, use timeouts and bounded retries, and provide a safe way to check again rather than fabricating an outcome.',
    source: {
      title: 'AWS Builders\' Library: Timeouts, retries, and backoff with jitter',
      section: 'Retries and backoff',
      url: 'https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/',
      quote: 'To avoid retrying for too long, implementations typically cap their backoff to a maximum value.',
    },
  },
  {
    id: 26,
    topic: 'Prompting & context',
    prompt: 'An answer must cite the exact document and page that support it. How should citations be produced?',
    options: [
      'Ask the model to include document titles and page numbers in its answer',
      'Keep source and page metadata with each passage, and build citations from it',
      'Cite whichever retrieved document ranked highest, since it is most likely the source',
      'Search the source documents for the answer text after generation to find a match',
    ],
    answer: 1,
    explanation: 'Citations should be grounded in application-held provenance metadata associated with each retrieved passage. The model can select evidence, while the application formats the authoritative source reference.',
    source: {
      title: 'Claude Docs: Citations',
      url: 'https://platform.claude.com/docs/en/build-with-claude/citations',
      quote: 'Claude can provide detailed citations when answering questions about documents, helping you track and verify the sources behind each response.',
    },
  },
  {
    id: 27,
    topic: 'Tools & agents',
    prompt: 'A tool returns text from an external web page, and the model will pass it to another tool. How should the returned text be handled?',
    options: [
      'Treat it as untrusted data and validate anything derived from it',
      'Trust it if the page comes from a domain on the allowlist',
      'Strip the HTML, then pass the text through as trusted tool input',
      'Have the model summarize it first, which removes any embedded instructions',
    ],
    answer: 0,
    explanation: 'Tool output can contain malicious, stale, or malformed content, even from allowed domains, and summarizing does not reliably remove injected instructions. Validate data before it influences another tool call or consequential action.',
    source: {
      title: 'Claude Docs: Handle tool calls',
      section: 'Handling results from client tools',
      url: 'https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls#handling-results-from-client-tools',
      quote: 'Tool results often carry content from sources outside your control: web pages, inbound email, user uploads, third-party APIs. Treat that content as untrusted',
    },
  },
  {
    id: 28,
    topic: 'Safety & operations',
    prompt: 'A thumbs-up rate is high, but users report occasional unsafe answers. What is the best next evaluation step?',
    options: [
      'Accept the reports as rare edge cases, since the overall rating is high',
      'Add a stronger safety instruction to the system prompt and ship it',
      'Review the incidents by category and add similar cases to the eval set',
      'Raise the thumbs-up target so the team optimizes harder for satisfaction',
    ],
    answer: 2,
    explanation: 'Aggregate satisfaction can hide low-frequency, high-impact failures. Triage incidents, review representative examples, and evaluate safety categories separately from general helpfulness.',
    source: {
      title: 'Claude Docs: Define success criteria and build evaluations',
      section: 'Define your success criteria',
      url: 'https://platform.claude.com/docs/en/test-and-evaluate/develop-tests#define-your-success-criteria',
      quote: 'Even "hazy" topics such as ethics and safety can be quantified',
    },
  },
  {
    id: 29,
    topic: 'Architecture',
    prompt: 'An assistant helps users review and submit purchase orders. Which system should remain the source of truth for approval and order status?',
    options: [
      'The conversation transcript, since it records every decision the user made',
      'A structured summary the assistant writes after each approval step',
      'The order details most recently shown in the mobile app',
      'The order service or database, with model output treated as a proposal',
    ],
    answer: 3,
    explanation: 'Business state belongs in the system of record. Treat model output as an input to a controlled workflow, and fetch the current order status from the authorized backend.',
    source: {
      title: 'OWASP Top 10 for LLM Applications: LLM05:2025 Improper Output Handling',
      section: 'Prevention and Mitigation Strategies',
      url: 'https://genai.owasp.org/llmrisk/llm052025-improper-output-handling/',
      quote: 'Treat the model as any other user, adopting a zero-trust approach, and apply proper input validation on responses coming from the model to backend functions.',
    },
  },
  {
    id: 30,
    topic: 'Prompting & context',
    prompt: "A prompt change needs to be compared with last month's production behavior. What makes the comparison reproducible?",
    options: [
      "Save last month's production answers and compare the new ones by reading them",
      'Version the prompt and eval data, and record the model and settings',
      "Rerun last month's examples with the current model and the new prompt",
      'Change the prompt and the model together, so they can be compared as one release',
    ],
    answer: 1,
    explanation: 'Reproducible comparisons require versioned prompts, representative inputs, and recorded model settings. This helps distinguish the effect of a prompt change from a model or configuration change.',
    source: {
      title: 'arXiv: A Methodological Guide on Using Large Language Models for Reproducible Text Annotation in the Social Sciences and Humanities with Python and R',
      section: 'Metadata documentation',
      url: 'https://arxiv.org/html/2604.09638',
      quote: 'This includes prompt templates, model identifiers and version numbers (preferably linked to model cards), data descriptions (e.g., via data cards), hyperparameter settings, and timestamps of API calls.',
    },
  },
  {
    id: 31,
    topic: 'Tools & agents',
    prompt: 'An agent is asked to complete a research task that may require several tool calls. Which guardrail helps prevent runaway execution?',
    options: [
      'Tell the model in the prompt to be efficient and avoid unnecessary steps',
      'Set step, time, and cost limits with a clear stop condition',
      'Let the model choose its own budget based on how hard the task looks',
      'Retry each failed tool call until it succeeds so the agent never gets stuck',
    ],
    answer: 1,
    explanation: 'Bound agent loops with explicit budgets and stopping criteria. When a limit is reached, return the partial state or a controlled failure instead of continuing indefinitely.',
    source: {
      title: 'Anthropic Engineering: Building effective agents',
      section: 'Agents',
      url: 'https://www.anthropic.com/engineering/building-effective-agents',
      quote: 'The task often terminates upon completion, but it’s also common to include stopping conditions (such as a maximum number of iterations) to maintain control.',
    },
  },
  {
    id: 32,
    topic: 'Safety & operations',
    prompt: "The assistant lacks enough information to answer a user's question reliably. What behavior is safest?",
    options: [
      'State the uncertainty, ask a focused follow-up, or route the case for review',
      'Give the most likely answer, since users prefer a direct response',
      'Answer, and add a general disclaimer that the information may be inaccurate',
      'Decline any question it cannot answer with complete certainty',
    ],
    answer: 0,
    explanation: 'When evidence is insufficient, uncertainty and clarification are safer than confident fabrication. Use a human handoff when the decision is consequential or cannot be resolved from available evidence.',
    source: {
      title: 'Claude Docs: Reduce hallucinations',
      section: 'Basic hallucination minimization strategies',
      url: 'https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-hallucinations#basic-hallucination-minimization-strategies',
      quote: 'Allow Claude to say "I don\'t know": Explicitly give Claude permission to admit uncertainty. This simple technique can drastically reduce false information.',
    },
  },
  {
    id: 33,
    topic: 'Architecture',
    prompt: 'A team must classify 50,000 archived support tickets with Claude by tomorrow. No user is waiting on any single result. Which approach fits best?',
    options: [
      'Send concurrent Messages API requests as fast as rate limits allow',
      'Use the Message Batches API and match results by custom_id',
      'Put many tickets in each request and split the reply by line order',
      'Use streaming requests so each classification arrives as soon as possible',
    ],
    answer: 1,
    explanation: 'The Message Batches API processes requests asynchronously at a lower price, which suits work that is not latency-sensitive. Results can come back in any order, so match them by custom_id, never by position.',
    source: {
      title: 'Claude Docs: Batch processing',
      section: 'Message Batches API',
      url: 'https://platform.claude.com/docs/en/build-with-claude/batch-processing#message-batches-api',
      quote: 'This approach is well-suited to tasks that do not require immediate responses, with most batches finishing in less than 1 hour while reducing costs by 50% and increasing throughput.',
    },
  },
  {
    id: 34,
    topic: 'Architecture',
    prompt: "A team wants a Claude agent that runs bash and edits files in a workspace, but they don't want to host the agent loop or the sandbox. Which option fits?",
    options: [
      'The SDK tool runner, with bash and file tools they implement and host',
      'The Claude Agent SDK, deployed on their own servers',
      'Claude Managed Agents, which runs the loop and hosts a per-session workspace',
      'The Message Batches API, with one batch item per agent step',
    ],
    answer: 2,
    explanation: 'The tool runner and the Claude Agent SDK provide the agent loop, but you host and deploy them. Managed Agents runs the loop on Anthropic infrastructure and gives each session a container for bash, file, and code tools.',
    source: {
      title: 'Claude Docs: Claude Managed Agents overview',
      url: 'https://platform.claude.com/docs/en/managed-agents/overview',
      quote: 'Claude Managed Agents provides the harness and infrastructure for running Claude as an autonomous agent. Instead of building your own agent loop, tool execution, and runtime, you get a fully managed environment',
    },
  },
  {
    id: 35,
    topic: 'Architecture',
    prompt: "In Claude Code, a task needs a search across hundreds of files to find one setting, and the main session's context should stay focused. What is a good approach?",
    options: [
      'Have the main session read every candidate file itself, one at a time',
      'Delegate the search to a subagent that returns a short summary of what it found',
      'List every file path in CLAUDE.md so the session loads them at startup',
      'Start a new session for each file and copy the findings back by hand',
    ],
    answer: 1,
    explanation: 'A subagent works in its own context window, so its many file reads stay out of the main session. Only its summary comes back, which keeps the main context for the actual task.',
    source: {
      title: 'Claude Code Docs: Create custom subagents',
      url: 'https://code.claude.com/docs/en/sub-agents',
      quote: 'Use one when a side task would flood your main conversation with search results, logs, or file contents you won\'t reference again: the subagent does that work in its own context and returns only the summary.',
    },
  },
  {
    id: 36,
    topic: 'Architecture',
    prompt: 'A route answering simple FAQ questions on a current Claude model meets its quality bar but costs more than planned. What should you try first?',
    options: [
      'Switch to the most capable model so fewer answers need follow-up questions',
      'Lower the effort level, then confirm quality on a sample of real requests',
      'Add a second, cheaper model that checks every answer before it is sent',
      'Move the system prompt into each user message to make requests smaller',
    ],
    answer: 1,
    explanation: 'Effort trades thoroughness for token spend within one model, and simple, high-volume routes often hold their quality at lower effort. Measure on real traffic before changing the default, and judge cost per completed task.',
    source: {
      title: 'Claude Docs: Choosing a model',
      section: 'Establish key criteria',
      url: 'https://platform.claude.com/docs/en/about-claude/models/choosing-a-model#establish-key-criteria',
      quote: 'Several Claude models support an effort parameter that trades intelligence for latency and cost within a single model. Tuning effort is often a better lever than switching models.',
    },
  },
  {
    id: 37,
    topic: 'Prompting & context',
    prompt: 'Requests share a large system prompt marked for caching, but usage shows cache_read_input_tokens is always zero. The system prompt begins with the current date and time. What is the likely fix?',
    options: [
      'Add cache_control to more blocks so a larger part of the prompt is cached',
      'Use a longer cache TTL so entries stay valid between requests',
      'Move the timestamp after the cached prefix so the prefix stays identical',
      'Send requests more often so the cache does not expire between them',
    ],
    answer: 2,
    explanation: 'Prompt caching matches an exact prefix. A timestamp at the start changes the prefix on every request, so nothing after it can be read from the cache. Keep stable content first and volatile values after the last cache breakpoint.',
    source: {
      title: 'Claude Docs: Prompt caching',
      section: 'Cache storage and sharing',
      url: 'https://platform.claude.com/docs/en/build-with-claude/prompt-caching#cache-storage-and-sharing',
      quote: 'Exact matching: Cache hits require 100% identical prompt segments, including all text and images up to and including the block marked with cache control.',
    },
  },
  {
    id: 38,
    topic: 'Prompting & context',
    prompt: 'An app caches its system prompt, but it builds the tools list per request, adding or removing tools based on the user. Cache hits are rare. Why?',
    options: [
      'Tools are cached separately, so their changes shorten the system prompt TTL',
      'Tools come first in the cached prefix, so changing them invalidates it',
      'Prompt caching only works for requests that include no tools',
      'The model ignores cache_control whenever tool_choice is set to auto',
    ],
    answer: 1,
    explanation: 'The cached prefix is built in the order tools, then system, then messages. Any change to the tool list changes the start of the prefix and invalidates everything after it. Keep the tool set deterministic.',
    source: {
      title: 'Claude Docs: Prompt caching',
      section: 'What invalidates the cache',
      url: 'https://platform.claude.com/docs/en/build-with-claude/prompt-caching#what-invalidates-the-cache',
      quote: 'Modifying tool definitions (names, descriptions, parameters) invalidates the entire cache',
    },
  },
  {
    id: 39,
    topic: 'Prompting & context',
    prompt: "A developer is surprised that a follow-up request to the Claude Messages API doesn't remember the previous answer. What explains this?",
    options: [
      'The previous answer expired from the server-side session after a few minutes',
      'Conversation memory must be turned on for the API key in the Console',
      'The API is stateless, so the client sends the conversation history each time',
      'Follow-up requests must include the previous response ID to continue',
    ],
    answer: 2,
    explanation: 'The Messages API keeps no conversation state between requests. The application sends the relevant history every time and decides what to keep, summarize, or compact.',
    source: {
      title: 'Claude Docs: Using the Messages API',
      section: 'Multiple conversational turns',
      url: 'https://platform.claude.com/docs/en/build-with-claude/working-with-messages#multiple-conversational-turns',
      quote: 'The Messages API is stateless, which means that you always send the full conversational history to the API.',
    },
  },
  {
    id: 40,
    topic: 'Prompting & context',
    prompt: "An app uses server-side compaction for long Claude conversations. After each turn, it stores only the assistant's text in its history. What goes wrong?",
    options: [
      'Nothing, because the server keeps the compacted history between requests',
      'The compaction blocks are dropped, so the compacted context is lost',
      'The stored text grows too long, so compaction runs again on every turn',
      'The model reads its stored text as user input and starts replying to itself',
    ],
    answer: 1,
    explanation: 'Compaction returns its summary as content blocks in the response. Append the full response content to the history, not just the text, or the compaction state is silently dropped.',
    source: {
      title: 'Claude Docs: Compaction at a token threshold',
      section: 'How compaction works',
      url: 'https://platform.claude.com/docs/en/build-with-claude/compaction-threshold#how-compaction-works',
      quote: 'On subsequent requests, append the response to your messages. The API automatically drops all content blocks prior to the compaction block, continuing the conversation from the summary.',
    },
  },
  {
    id: 41,
    topic: 'Tools & agents',
    prompt: 'Claude returns three tool_use blocks in one response. How should the application return the results?',
    options: [
      'Three user messages, one tool_result each, in the order the calls finish',
      'One user message containing all three tool_result blocks',
      'Only the first result, letting the model request the others again',
      'One text block combining the three outputs, so the model sees a single result',
    ],
    answer: 1,
    explanation: 'Answer parallel tool calls together: return every tool_result, each matching its tool_use id, in a single user message. Splitting them across messages teaches the model to stop making parallel calls.',
    source: {
      title: 'Claude Docs: Parallel tool use',
      section: 'Execution semantics',
      url: 'https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use#execution-semantics',
      quote: 'Whichever strategy you use, return one tool_result for each tool_use block, all together in the next user message.',
    },
  },
  {
    id: 42,
    topic: 'Tools & agents',
    prompt: 'One of the tools Claude called throws an exception. What should the application send back?',
    options: [
      'Nothing for that call, so the model only sees the successful results',
      'An empty but successful result, so the model can carry on with its plan',
      'A tool_result marked is_error: true that describes the failure',
      'An error message to the end user, ending the conversation',
    ],
    answer: 2,
    explanation: 'Report the failure to the model as an error tool_result. It can then retry, try another approach, or explain the problem, and the conversation stays valid because every tool_use has a result.',
    source: {
      title: 'Claude Docs: Handle tool calls',
      section: 'Handling errors with is_error',
      url: 'https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls',
      quote: 'If the tool itself throws an error during execution (for example, a network error when fetching weather data), you can return the error message in the content along with "is_error": true',
    },
  },
  {
    id: 43,
    topic: 'Tools & agents',
    prompt: 'Claude tool inputs sometimes miss required fields. Which change guarantees that tool_use inputs match the schema?',
    options: [
      'Describe the required fields in more detail in the tool description',
      'Set strict: true on the tool definition, with additionalProperties: false',
      'Set strict: true on tool_choice so every tool call the model makes is checked',
      'Add several examples of correct tool calls to the system prompt',
    ],
    answer: 1,
    explanation: 'Strict tool use constrains generation so inputs validate against the schema. It goes on the tool definition, not on tool_choice, and the schema needs additionalProperties: false and a required list.',
    source: {
      title: 'Claude Docs: Structured outputs',
      url: 'https://platform.claude.com/docs/en/build-with-claude/structured-outputs',
      quote: 'Strict tool use (strict: true): Guarantee schema validation on tool names and inputs.',
    },
  },
  {
    id: 44,
    topic: 'Tools & agents',
    prompt: 'A team wants Claude Code to run the code formatter after every file edit, with no exceptions. What is the most reliable way to set this up?',
    options: [
      'Add "always run the formatter after editing a file" to CLAUDE.md',
      'Ask Claude to remember the rule for all future sessions',
      'Configure a hook in settings that runs the formatter after edits',
      'Create a slash command for formatting and remind people to use it',
    ],
    answer: 2,
    explanation: 'CLAUDE.md and memory are instructions the model usually follows. Hooks are run by the Claude Code harness itself, so they fire every time the configured event happens.',
    source: {
      title: 'Claude Code Docs: Automate actions with hooks',
      url: 'https://code.claude.com/docs/en/hooks-guide',
      quote: 'Claude Code runs them at specific points in its lifecycle, which gives you deterministic control: certain actions always happen rather than relying on the LLM to choose to run them.',
    },
  },
  {
    id: 45,
    topic: 'Safety & operations',
    prompt: 'An app shows the first text block of every Claude response to the user. Sometimes users see answers that stop mid-sentence. What should the app check?',
    options: [
      'Whether the text ends with punctuation, retrying with a new prompt if not',
      'The stop_reason, handling max_tokens and refusal before showing content',
      'The answer length, rejecting replies shorter than a set number of words',
      'The model ID in the response, in case a smaller model answered instead',
    ],
    answer: 1,
    explanation: 'stop_reason says why generation ended: max_tokens means the output was cut off, and refusal means the model declined. Check it before treating the content as a complete answer.',
    source: {
      title: 'Claude Docs: Handling stop reasons',
      url: 'https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons',
      quote: 'Every Messages API response includes a stop_reason field that tells you why Claude stopped generating. Check this field to decide whether to use the response as-is, continue the conversation, retry, or fall back to another model.',
    },
  },
  {
    id: 46,
    topic: 'Safety & operations',
    prompt: 'Under heavy load, some Claude API calls fail with HTTP 429. What is the best way to handle this?',
    options: [
      'Retry every failed request immediately until it succeeds',
      'Back off, honor retry-after, and do not retry 400 errors',
      'Rotate to a different API key each time a 429 is returned',
      'Treat 429 like a 400 and show the user an invalid request error',
    ],
    answer: 1,
    explanation: 'A 429 means the request was rate-limited and can succeed later, so back off and respect retry-after. A 400 means the request itself is wrong and will fail again. The SDKs retry 429 and 5xx errors a few times by default.',
    source: {
      title: 'Claude Docs: Claude API errors',
      section: 'HTTP errors',
      url: 'https://platform.claude.com/docs/en/api/errors#http-errors',
      quote: 'The official SDK automatically retries transient failures (such as connection errors, rate limits, and 5xx server errors) with exponential backoff, twice by default, honoring the retry-after header when present.',
    },
  },
  {
    id: 47,
    topic: 'Safety & operations',
    prompt: 'A team lets Claude Code run commands in a shared repository and must make sure it never force-pushes. What is the strongest control?',
    options: [
      'A clear rule in CLAUDE.md telling Claude never to force-push or delete branches',
      "Deny rules for those commands in the project's permission settings",
      'Asking Claude at the start of each session to confirm before any git command',
      'Reviewing every session transcript afterwards and reverting any bad pushes',
    ],
    answer: 1,
    explanation: 'Permission rules are enforced by the Claude Code harness regardless of what the model decides. Instructions in CLAUDE.md help, but they are guidance, not a hard boundary.',
    source: {
      title: 'Claude Code Docs: Configure permissions',
      section: 'Manage permissions',
      url: 'https://code.claude.com/docs/en/permissions#manage-permissions',
      quote: 'A broad deny rule like Bash(aws *) blocks every matching call, including calls that also match a narrower allow rule like Bash(aws s3 ls). An allow rule can\'t carve an exception out of a deny rule.',
    },
  },
  {
    id: 48,
    topic: 'Safety & operations',
    prompt: 'A team wants to connect a third-party MCP server that gives Claude access to their ticketing system. What should they do first?',
    options: [
      'Connect it directly, since MCP is a standard protocol and its servers are safe by design',
      'Review the server, scope its credentials, and treat its output as untrusted',
      'Give it an admin token, so it never fails because of missing permissions',
      'Connect it, and add a system prompt line telling Claude not to misuse it',
    ],
    answer: 1,
    explanation: 'MCP standardizes how tools connect, not whether they can be trusted. Tool descriptions and results can carry injected instructions, so vet the server, limit its credentials to what the task needs, and keep approvals for risky actions.',
    source: {
      title: 'Claude Code Docs: Connect Claude Code to tools via MCP',
      section: 'Find and build MCP servers',
      url: 'https://code.claude.com/docs/en/mcp#find-and-build-mcp-servers',
      quote: 'Verify you trust each server before connecting it. Servers that fetch external content can expose you to prompt injection risk.',
    },
  },
  {
    id: 49,
    topic: 'Architecture',
    prompt: 'A feature asks Claude for long reports, and some requests fail with HTTP timeouts before the response arrives. What is the best fix?',
    options: [
      'Lower max_tokens until the timeouts stop, even if reports get cut off',
      'Stream the response and assemble the final message as it arrives',
      'Raise the client timeout to an hour and keep the request non-streaming',
      'Split each report into one request per paragraph and send them in parallel',
    ],
    answer: 1,
    explanation: 'Streaming keeps the connection active while tokens are generated, avoiding timeouts on long outputs, and lets the app show progress. The SDKs have helpers that collect the stream into a final message when you only need the result.',
    source: {
      title: 'Claude Docs: Streaming messages',
      section: 'Get the final message without handling events',
      url: 'https://platform.claude.com/docs/en/build-with-claude/streaming#get-the-final-message-without-handling-events',
      quote: 'This is especially useful for requests with large max_tokens values, where the SDK requires streaming to avoid HTTP timeouts.',
    },
  },
  {
    id: 50,
    topic: 'Architecture',
    prompt: 'Users ask many follow-up questions about the same large PDF, and the app re-sends it as base64 in every request. What is a better design?',
    options: [
      'Upload it once with the Files API and reference its file_id in each request',
      'Convert the PDF to plain text in the app and paste it into every request',
      'Send only the first few pages, since most questions are about the opening',
      'Ask the model to summarize the PDF once, then answer from that summary only',
    ],
    answer: 0,
    explanation: 'The Files API stores a document once so later requests reference it by file_id instead of re-uploading it. Pair this with prompt caching to reduce the cost of reprocessing the same content. A summary alone loses detail the follow-up questions may need.',
    source: {
      title: 'Claude Docs: Files API',
      url: 'https://platform.claude.com/docs/en/build-with-claude/files',
      quote: 'The Files API lets you upload and manage files to use with the Claude API without re-uploading content with each request.',
    },
  },
  {
    id: 51,
    topic: 'Architecture',
    prompt: 'During a provider incident, model calls return overloaded or 5xx errors for several minutes. How should a user-facing assistant behave?',
    options: [
      'Keep users waiting on a loading spinner until the provider recovers',
      'Show a generic error and suggest that users reinstall the app',
      'Retry with backoff a few times, then degrade gracefully and tell the user',
      'Answer from a cache of replies to similar questions, presented as live answers',
    ],
    answer: 2,
    explanation: 'Plan for dependency failures: bounded retries with backoff, then a clear degraded state such as queueing the request, a fallback model, or an honest message. Never present stale or substituted answers as live results.',
    source: {
      title: 'Claude Docs: Claude API errors',
      section: 'HTTP errors',
      url: 'https://platform.claude.com/docs/en/api/errors#http-errors',
      quote: '500 - api_error: An unexpected error has occurred internal to Anthropic\'s systems. Retry the request with exponential backoff; if the error persists, contact support with the request ID.',
    },
  },
  {
    id: 52,
    topic: 'Prompting & context',
    prompt: 'An app sends contract documents to Claude and needs each claim in the answer linked to the exact supporting text. Which approach fits best?',
    options: [
      'Ask the model to quote the source text in brackets after each claim',
      'Enable citations on the document blocks and render them from the response',
      'Search the documents afterwards for sentences that resemble each claim',
      'Number every sentence in the prompt and ask the model to list the numbers it used',
    ],
    answer: 1,
    explanation: 'With citations enabled on document blocks, the response carries structured citations that point to the cited text and its location. The app can render these directly instead of relying on quotes the model writes itself.',
    source: {
      title: 'Claude Docs: Citations',
      url: 'https://platform.claude.com/docs/en/build-with-claude/citations',
      quote: 'Claude can provide detailed citations when answering questions about documents, helping you track and verify the sources behind each response.',
    },
  },
  {
    id: 53,
    topic: 'Prompting & context',
    prompt: 'A prompt includes several long documents plus a question about them. How should it be laid out?',
    options: [
      'The question first, then the documents, so the model knows what to look for',
      'All documents merged into one block of text to save tokens on separators',
      'Each document in its own tagged section with metadata, and the question last',
      'Only the document titles, letting the model ask for the ones it needs',
    ],
    answer: 2,
    explanation: 'Clearly delimited documents with source metadata are easier to tell apart and cite. With long inputs, placing the documents first and the question at the end tends to improve answer quality.',
    source: {
      title: 'Claude Docs: Prompting best practices',
      section: 'Long context prompting',
      url: 'https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices#long-context-prompting',
      quote: 'Put longform data at the top: Place your long documents and inputs near the top of your prompt, above your query, instructions, and examples. This improves performance across all models.',
    },
  },
  {
    id: 54,
    topic: 'Prompting & context',
    prompt: 'A team wants to check whether a prompt fits within its token budget before sending it to Claude. What is the most accurate method?',
    options: [
      'Divide the character count by four, which is accurate for any model',
      'Use the token counting endpoint for the target model',
      "Use another provider's open-source tokenizer, since tokenizers are similar",
      'Send the request and read the token count from the error if it is too large',
    ],
    answer: 1,
    explanation: 'Tokenizers differ between providers and can change between model generations. The token counting endpoint returns the count for the specific model, so estimates match what will actually be billed and checked.',
    source: {
      title: 'Claude Docs: Token counting',
      section: 'Token counts on Claude Fable and Claude Mythos models',
      url: 'https://platform.claude.com/docs/en/build-with-claude/token-counting#token-counts-on-claude-fable-and-claude-mythos-models',
      quote: 'The token counting endpoint counts under the tokenizer of the model you pass.',
    },
  },
  {
    id: 55,
    topic: 'Tools & agents',
    prompt: 'Claude often picks the wrong tool among several similar ones. What change usually helps most?',
    options: [
      'Give the tools shorter, more distinctive names so they are easier to tell apart',
      'Remove the tool descriptions so the model relies on the parameter names',
      'Describe what each tool does, when to use it, and what its inputs mean',
      'Add a system prompt line saying the model must be careful choosing tools',
    ],
    answer: 2,
    explanation: 'Tool descriptions are the main signal the model uses to choose a tool. Explain the purpose, when to use and not use the tool, and what each parameter means; consider merging tools that overlap.',
    source: {
      title: 'Claude Docs: Define tools',
      section: 'Best practices for tool definitions',
      url: 'https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools#best-practices-for-tool-definitions',
      quote: 'Provide extremely detailed descriptions. This is by far the most important factor in tool performance.',
    },
  },
  {
    id: 56,
    topic: 'Tools & agents',
    prompt: 'An agent has access to several hundred tools, and their definitions fill much of the context window. What is a good way to handle this?',
    options: [
      'Use tool search with deferred loading so only relevant definitions load',
      'Send all definitions on every request and rely on prompt caching to cover it',
      'Pick 20 tools at random for each request to keep the prompt small',
      'Merge every tool into one generic tool that takes a free-text command',
    ],
    answer: 0,
    explanation: 'With tool search, most tools are marked for deferred loading and the model searches for the ones it needs, so their definitions enter the context only when relevant. Caching reduces cost but not the context space the definitions use.',
    source: {
      title: 'Claude Docs: Tool search tool',
      url: 'https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool',
      quote: 'Instead of loading all tool definitions into the context window up front, Claude searches your tool catalog (including tool names, descriptions, argument names, and argument descriptions) and loads only the tools it needs.',
    },
  },
  {
    id: 57,
    topic: 'Tools & agents',
    prompt: 'A team wants Claude Code to follow the same project conventions and build commands for everyone who works in a repository. Where should these go?',
    options: [
      "In each developer's personal memory, added the first time they use the tool",
      'In a CLAUDE.md file at the repository root, committed to version control',
      'In a long first message each developer pastes into every new session',
      'In comments at the top of every source file in the repository',
    ],
    answer: 1,
    explanation: 'A project CLAUDE.md is loaded automatically in sessions in that repository, and committing it shares the same guidance with the whole team. Personal memory and pasted prompts drift between people.',
    source: {
      title: 'Claude Code Docs: How Claude remembers your project',
      section: 'Choose where to put CLAUDE.md files',
      url: 'https://code.claude.com/docs/en/memory#choose-where-to-put-claude-md-files',
      quote: 'Project instructions: ./CLAUDE.md or ./.claude/CLAUDE.md … Team-shared instructions for the project … Shared with: Team members via source control',
    },
  },
  {
    id: 58,
    topic: 'Safety & operations',
    prompt: 'An email assistant can read private messages, process untrusted incoming email, and send email. What is the most important risk control?',
    options: [
      'Tell the model never to forward private information to anyone',
      'Use the most capable model, since it is harder to manipulate',
      'Require user approval for outbound email, or remove the send capability',
      'Scan incoming email for the word "instructions" and quarantine any matches',
    ],
    answer: 2,
    explanation: 'Private data, untrusted content, and a way to send data out together let injected instructions exfiltrate information. Break that combination by gating or removing the outbound channel; prompt rules and filters alone can be bypassed.',
    source: {
      title: 'Simon Willison: The lethal trifecta for AI agents',
      url: 'https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/',
      quote: 'The lethal trifecta of capabilities is: Access to your private data … Exposure to untrusted content … The ability to externally communicate in a way that could be used to steal your data',
    },
  },
  {
    id: 59,
    topic: 'Safety & operations',
    prompt: 'A team uses a model as a judge to grade thousands of responses in an eval. What makes those grades trustworthy?',
    options: [
      'Use the same model as the judge, since it knows how it meant to answer',
      'Give the judge a clear rubric and check its grades against human labels',
      'Ask the judge for a single 1–10 score with no explanation, to save tokens',
      'Accept the grades as long as the average score looks reasonable overall',
    ],
    answer: 1,
    explanation: 'An automated judge needs a specific rubric and calibration: compare its grades with human judgments on a sample and fix disagreements before trusting it at scale. Recheck agreement when the judge prompt or model changes.',
    source: {
      title: 'Claude Docs: Define success criteria and build evaluations',
      section: 'Grade your evaluations',
      url: 'https://platform.claude.com/docs/en/test-and-evaluate/develop-tests#grade-your-evaluations',
      quote: 'LLM-based grading: Fast and flexible, scalable and suitable for complex judgment. Test to ensure reliability first then scale.',
    },
  },
  {
    id: 60,
    topic: 'Safety & operations',
    prompt: 'A team runs Claude Code non-interactively in CI to fix failing tests on pull requests. Which setup is safest?',
    options: [
      'Give it an admin token and permission to run any command, to avoid failures',
      'Scope its token narrowly and allow only the tools and commands the job needs',
      'Run it on the main branch with push access so that fixes land faster',
      'Let it read all repository secrets so it can debug any failing integration',
    ],
    answer: 1,
    explanation: 'Unattended runs have no human approving each step, so limits must be set up front: least-privilege credentials, an explicit allowlist of tools and commands, and changes proposed through a pull request rather than pushed directly.',
    source: {
      title: 'Claude Code Docs: Claude Code GitHub Actions',
      section: 'Protect your credentials',
      url: 'https://code.claude.com/docs/en/github-actions#protect-your-credentials',
      quote: 'Grant the workflow only the permissions it needs, and review Claude\'s changes before merging.',
    },
  },
];

const TOPICS: Topic[] = [
  'Architecture',
  'Prompting & context',
  'Tools & agents',
  'Safety & operations',
];

const EXAM_LENGTH = 10;
const SECONDS_PER_QUESTION = 2 * 60;

function SourceNote({ source }: { source: Source }) {
  return (
    <View style={styles.sourceNote}>
      <Text style={styles.sourceKicker}>SOURCE</Text>
      <Text style={styles.sourceQuote}>“{source.quote}”</Text>
      <Text
        accessibilityRole="link"
        onPress={() => Linking.openURL(source.url).catch(() => {})}
        style={styles.sourceLink}
      >
        {source.title}{source.section ? ` › ${source.section}` : ''}
      </Text>
    </View>
  );
}

function logAd(event: string, detail?: unknown) {
  if (__DEV__) console.log(`[ads] ${event}`, detail ?? '');
}

function shuffle<T>(items: T[]) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

const COLORS = {
  background: '#F4F7F1',
  paper: '#FFFFFF',
  ink: '#19332B',
  muted: '#738078',
  line: '#E0E8DF',
  green: '#2E6A50',
  greenDark: '#183B2E',
  lime: '#D8F27A',
  orange: '#F08C68',
  paleGreen: '#EAF3E8',
  paleOrange: '#FFF0E9',
};

export default function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [mode, setMode] = useState<Mode>('timed');
  const [questions, setQuestions] = useState(QUESTIONS.slice(0, EXAM_LENGTH));
  const [topicFilter, setTopicFilter] = useState<Topic | null>(null);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [checked, setChecked] = useState<number[]>([]);
  const [flagged, setFlagged] = useState<number[]>([]);
  const [secondsLeft, setSecondsLeft] = useState(EXAM_LENGTH * SECONDS_PER_QUESTION);
  const [fullExam, setFullExam] = useState(false);
  const [latestResult, setLatestResult] = useState<AttemptResult | null>(null);
  const [quickSet, setQuickSet] = useState(false);
  const [adStatus, setAdStatus] = useState<'idle' | 'loading' | 'showing'>('idle');
  const [nextAdAt, setNextAdAt] = useState(QUESTIONS_PER_AD);
  const interstitialRef = useRef<InterstitialAd | null>(null);
  const adTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const adsInitializedRef = useRef(false);
  const adsInitializationFailedRef = useRef(false);
  const pendingAdActionRef = useRef<(() => void) | null>(null);

  const timedLength = fullExam ? QUESTIONS.length : EXAM_LENGTH;
  const currentQuestion = questions[questionIndex];
  const correctCount = questions.reduce(
    (total, question) => total + (answers[question.id] === question.answer ? 1 : 0),
    0,
  );
  const answeredCount = questions.filter((question) => answers[question.id] !== undefined).length;
  const isAnswerChecked = checked.includes(currentQuestion?.id ?? -1);
  const selectedAnswer = currentQuestion ? answers[currentQuestion.id] : undefined;

  function clearAdTimeout() {
    if (adTimeoutRef.current) clearTimeout(adTimeoutRef.current);
    adTimeoutRef.current = null;
  }

  function completeAdBreak() {
    clearAdTimeout();
    const action = pendingAdActionRef.current;
    pendingAdActionRef.current = null;
    setAdStatus('idle');
    action?.();
  }

  // The ad object ignores load() while it is already loaded or loading.
  function loadInterstitial(ad: InterstitialAd | null = interstitialRef.current) {
    if (!ad || !adsInitializedRef.current) return;
    logAd('load requested');
    ad.load();
  }

  function showInterstitial(ad: InterstitialAd) {
    clearAdTimeout();
    setAdStatus('showing');
    ad.show().catch((error: unknown) => {
      logAd('show failed', error);
      completeAdBreak();
    });
  }

  function continueAfterQuestionBatch(action: () => void) {
    if (answeredCount < nextAdAt) {
      action();
      return;
    }

    setNextAdAt((milestone) => milestone + QUESTIONS_PER_AD);
    const ad = interstitialRef.current;
    if (!ad || adsInitializationFailedRef.current) {
      logAd('break skipped: ads unavailable');
      action();
      return;
    }

    logAd(`break after ${answeredCount} answers`, { loaded: ad.loaded });
    pendingAdActionRef.current = action;
    setAdStatus('loading');
    if (ad.loaded) {
      showInterstitial(ad);
      return;
    }
    adTimeoutRef.current = setTimeout(() => {
      logAd('break skipped: load timed out');
      completeAdBreak();
    }, AD_LOAD_TIMEOUT_MS);
    loadInterstitial(ad);
  }

  useEffect(() => {
    let isActive = true;
    AsyncStorage.getItem(RESULT_STORAGE_KEY)
      .then((storedResult) => {
        if (storedResult && isActive) setLatestResult(JSON.parse(storedResult) as AttemptResult);
      })
      .catch(() => {});
    return () => { isActive = false; };
  }, []);

  useEffect(() => {
    if (!INTERSTITIAL_AD_UNIT_ID) return;

    const ad = InterstitialAd.createForAdRequest(INTERSTITIAL_AD_UNIT_ID);
    interstitialRef.current = ad;
    ad.addAdEventListener(AdEventType.LOADED, () => {
      logAd('loaded');
      if (pendingAdActionRef.current) showInterstitial(ad);
    });
    ad.addAdEventListener(AdEventType.OPENED, () => {
      logAd('opened');
      setAdStatus('showing');
    });
    ad.addAdEventListener(AdEventType.CLOSED, () => {
      logAd('closed');
      completeAdBreak();
      loadInterstitial(ad);
    });
    ad.addAdEventListener(AdEventType.ERROR, (error) => {
      logAd('error', error);
      completeAdBreak();
    });

    mobileAds()
      .initialize()
      .then(() => {
        logAd('initialized');
        adsInitializedRef.current = true;
        loadInterstitial(ad);
      })
      .catch((error: unknown) => {
        logAd('initialization failed', error);
        adsInitializationFailedRef.current = true;
        completeAdBreak();
      });

    return () => {
      adsInitializedRef.current = false;
      interstitialRef.current = null;
      clearAdTimeout();
      ad.destroy();
    };
  }, []);

  useEffect(() => {
    if (screen !== 'exam' || mode !== 'timed' || adStatus !== 'idle') return;
    const timer = setInterval(() => setSecondsLeft((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => clearInterval(timer);
  }, [screen, mode, adStatus]);

  useEffect(() => {
    if (screen === 'exam' && mode === 'timed' && adStatus === 'idle' && secondsLeft === 0) {
      continueAfterQuestionBatch(finishExam);
    }
  }, [screen, mode, adStatus, secondsLeft]);

  function startSession(nextMode: Mode, topic: Topic | null = null, quick = false) {
    const available = shuffle(topic ? QUESTIONS.filter((question) => question.topic === topic) : QUESTIONS)
      .map((question) => {
        const options = shuffle(question.options);
        return { ...question, options, answer: options.indexOf(question.options[question.answer]) };
      });
    const sessionLength = quick ? 5 : nextMode === 'timed' && !topic && !fullExam ? EXAM_LENGTH : available.length;
    const sessionQuestions = available.slice(0, sessionLength);
    setMode(nextMode);
    setTopicFilter(topic);
    setQuickSet(quick);
    setQuestions(sessionQuestions);
    setQuestionIndex(0);
    setAnswers({});
    setChecked([]);
    setFlagged([]);
    setNextAdAt(QUESTIONS_PER_AD);
    pendingAdActionRef.current = null;
    setAdStatus('idle');
    setSecondsLeft(sessionQuestions.length * SECONDS_PER_QUESTION);
    setScreen('exam');
  }

  function finishExam() {
    const result: AttemptResult = {
      score: Math.round((correctCount / questions.length) * 100),
      correct: correctCount,
      total: questions.length,
      topic: topicFilter ?? 'All topics',
      completedAt: new Date().toISOString(),
    };
    setLatestResult(result);
    AsyncStorage.setItem(RESULT_STORAGE_KEY, JSON.stringify(result)).catch(() => {});
    setScreen('results');
  }

  function chooseAnswer(optionIndex: number) {
    if (!currentQuestion) return;
    setAnswers((previous) => ({ ...previous, [currentQuestion.id]: optionIndex }));
    setChecked((previous) => previous.filter((id) => id !== currentQuestion.id));
  }

  function checkAnswer() {
    if (!currentQuestion || selectedAnswer === undefined) return;
    setChecked((previous) => [...previous, currentQuestion.id]);
  }

  function moveQuestion(direction: number) {
    const nextIndex = questionIndex + direction;
    if (nextIndex < 0) return;
    const advance = () => {
      if (nextIndex >= questions.length) finishExam();
      else setQuestionIndex(nextIndex);
    };
    if (direction > 0) {
      continueAfterQuestionBatch(advance);
      return;
    }
    advance();
  }

  function leaveSession() {
    Alert.alert('Leave this session?', 'Your answers will not be saved.', [
      { text: 'Keep going', style: 'cancel' },
      {
        text: 'Leave',
        style: 'destructive',
        onPress: () => {
          pendingAdActionRef.current = null;
          setAdStatus('idle');
          setScreen('home');
        },
      },
    ]);
  }

  function toggleFlag() {
    if (!currentQuestion) return;
    setFlagged((previous) =>
      previous.includes(currentQuestion.id)
        ? previous.filter((id) => id !== currentQuestion.id)
        : [...previous, currentQuestion.id],
    );
  }

  function formatTime(totalSeconds: number) {
    const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
    const seconds = (totalSeconds % 60).toString().padStart(2, '0');
    return `${minutes}:${seconds}`;
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      {screen === 'home' && (
        <ScrollView contentContainerStyle={styles.homeContent} showsVerticalScrollIndicator={false}>
          <View style={styles.header}>
            <View style={styles.brandMark}><Text style={styles.brandMarkText}>F</Text></View>
            <View style={styles.brandCopy}>
              <Text style={styles.brandName}>FIELDNOTES</Text>
              <Text style={styles.brandSub}>AI SYSTEMS PRACTICE</Text>
            </View>
            <View style={styles.edition}><Text style={styles.editionText}>01</Text></View>
          </View>

          <View style={styles.intro}>
            <Text style={styles.eyebrow}>CLAUDE SOLUTION ARCHITECT FOUNDATIONS</Text>
            <Text style={styles.headline}>Make good{ '\n'}systems choices.</Text>
            <Text style={styles.introText}>A focused practice desk for designing useful, reliable AI solutions.</Text>
          </View>

          <View style={styles.modeSwitch}>
            <Pressable onPress={() => setMode('timed')} style={[styles.modeButton, mode === 'timed' && styles.modeButtonActive]}>
              <Text style={[styles.modeButtonText, mode === 'timed' && styles.modeButtonTextActive]}>Timed exam</Text>
            </Pressable>
            <Pressable onPress={() => setMode('study')} style={[styles.modeButton, mode === 'study' && styles.modeButtonActive]}>
              <Text style={[styles.modeButtonText, mode === 'study' && styles.modeButtonTextActive]}>Study mode</Text>
            </Pressable>
          </View>

          <View style={styles.examCard}>
            <View style={styles.examCardTop}>
              <View>
                <Text style={styles.cardEyebrow}>{mode === 'timed' ? 'FULL-LENGTH SIMULATION' : 'GUIDED PRACTICE'}</Text>
                <Text style={styles.examCardTitle}>{mode === 'timed' ? 'The foundations run' : 'Learn as you go'}</Text>
              </View>
              <View style={styles.cardStamp}><Text style={styles.cardStampText}>{mode === 'timed' ? '01' : '02'}</Text></View>
            </View>
            <Text style={styles.examCardBody}>
              {mode === 'timed'
                ? `${timedLength} original questions across architecture, context, tools, and operations.`
                : 'Answer at your own pace. Check each response to see the reasoning.'}
            </Text>
            {mode === 'timed' && (
              <View style={styles.lengthSwitch}>
                {[false, true].map((full) => (
                  <Pressable
                    key={String(full)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: fullExam === full }}
                    onPress={() => setFullExam(full)}
                    style={[styles.lengthButton, fullExam === full && styles.lengthButtonActive]}
                  >
                    <Text style={[styles.lengthButtonText, fullExam === full && styles.lengthButtonTextActive]}>
                      {full ? `All ${QUESTIONS.length}` : `${EXAM_LENGTH} questions`}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
            <View style={styles.examMetaRow}>
              <Text style={styles.examMeta}>{mode === 'timed' ? `${timedLength} QUESTIONS` : `${QUESTIONS.length} QUESTIONS`}</Text>
              <View style={styles.metaDot} />
              <Text style={styles.examMeta}>{mode === 'timed' ? `${(timedLength * SECONDS_PER_QUESTION) / 60} MIN` : 'NO TIMER'}</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              onPress={() => startSession(mode)}
              style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
            >
              <Text style={styles.primaryButtonText}>{mode === 'timed' ? 'Start timed exam' : 'Start study session'}</Text>
              <Text style={styles.primaryArrow}>›</Text>
            </Pressable>
          </View>

          <View style={styles.quickRow}>
            <View style={styles.quickCopy}>
              <Text style={styles.quickTitle}>Short on time?</Text>
              <Text style={styles.quickBody}>Try a 5-question warm-up.</Text>
            </View>
            <Pressable accessibilityRole="button" onPress={() => startSession('study', null, true)} style={styles.quickButton}>
              <Text style={styles.quickButtonText}>Quick set  +</Text>
            </Pressable>
          </View>

          {latestResult && (
            <View style={styles.recentResult}>
              <View style={styles.recentResultCopy}>
                <Text style={styles.recentResultLabel}>LAST RESULT</Text>
                <Text style={styles.recentResultTopic}>{latestResult.topic}</Text>
              </View>
              <Text style={styles.recentResultScore}>{latestResult.score}%</Text>
            </View>
          )}

          <View style={styles.sectionHeading}>
            <Text style={styles.sectionTitle}>Study by topic</Text>
            <Text style={styles.sectionNote}>{QUESTIONS.length} QUESTIONS</Text>
          </View>
          <View style={styles.topicList}>
            {TOPICS.map((topic, index) => {
              const count = QUESTIONS.filter((question) => question.topic === topic).length;
              return (
                <Pressable key={topic} onPress={() => startSession('study', topic)} style={styles.topicRow}>
                  <View style={[styles.topicNumber, index === 0 && styles.topicNumberHighlight]}>
                    <Text style={[styles.topicNumberText, index === 0 && styles.topicNumberTextHighlight]}>{String(index + 1).padStart(2, '0')}</Text>
                  </View>
                  <View style={styles.topicCopy}>
                    <Text style={styles.topicName}>{topic}</Text>
                    <Text style={styles.topicCount}>{count} QUESTIONS</Text>
                  </View>
                  <Text style={styles.topicArrow}>›</Text>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.footerNote}>
            <Text style={styles.footerRule} />
            <Text style={styles.footerText}>Independent study tool. Not affiliated with Anthropic. Questions are original practice material, not official exam content.</Text>
          </View>
        </ScrollView>
      )}

      {screen === 'exam' && currentQuestion && (
        <ScrollView contentContainerStyle={styles.examContent} showsVerticalScrollIndicator={false}>
          <View style={styles.examHeader}>
            <Pressable accessibilityRole="button" accessibilityLabel="Leave session" onPress={leaveSession} style={styles.closeButton}>
              <Text style={styles.closeButtonText}>×</Text>
            </Pressable>
            <View style={styles.examHeaderCopy}>
              <Text style={styles.examHeaderKicker}>{mode === 'timed' ? 'TIMED EXAM' : 'STUDY SESSION'}</Text>
              <Text style={styles.examHeaderTitle}>{topicFilter ?? 'Foundations'}</Text>
            </View>
            {mode === 'timed' ? (
              <View style={[styles.timerPill, secondsLeft < 120 && styles.timerPillUrgent]}>
                <Text style={[styles.timerText, secondsLeft < 120 && styles.timerTextUrgent]}>{formatTime(secondsLeft)}</Text>
              </View>
            ) : <View style={styles.timerSpacer} />}
          </View>

          <View style={styles.progressInfo}>
            <Text style={styles.progressLabel}>QUESTION {String(questionIndex + 1).padStart(2, '0')} <Text style={styles.progressDivider}>/</Text> {String(questions.length).padStart(2, '0')}</Text>
            <Text style={styles.progressLabel}>{answeredCount} ANSWERED</Text>
          </View>
          <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${((questionIndex + 1) / questions.length) * 100}%` }]} /></View>
          {adStatus === 'loading' && (
            <View style={styles.adPauseNotice}>
              <Text style={styles.adPauseTitle}>Preparing an ad break</Text>
              <Text style={styles.adPauseText}>{mode === 'timed' ? 'Your exam timer is paused.' : 'Your session is paused.'}</Text>
            </View>
          )}

          {mode === 'timed' && (
            <View style={styles.navigator}>
              {questions.map((question, index) => {
                const isCurrent = index === questionIndex;
                const isAnswered = answers[question.id] !== undefined;
                const isFlagged = flagged.includes(question.id);
                return (
                  <Pressable
                    key={question.id}
                    accessibilityRole="button"
                    accessibilityLabel={`Go to question ${index + 1}${isAnswered ? ', answered' : ''}${isFlagged ? ', flagged' : ''}`}
                    onPress={() => setQuestionIndex(index)}
                    style={[styles.navigatorItem, isCurrent && styles.navigatorItemCurrent, isAnswered && !isCurrent && styles.navigatorItemAnswered]}
                  >
                    <Text style={[styles.navigatorText, (isCurrent || isAnswered) && styles.navigatorTextActive]}>{index + 1}</Text>
                    {isFlagged && <View style={styles.flagDot} />}
                  </Pressable>
                );
              })}
            </View>
          )}

          <View style={styles.questionHeading}>
            <View style={styles.topicPill}><Text style={styles.topicPillText}>{currentQuestion.topic.toUpperCase()}</Text></View>
            <Pressable accessibilityRole="button" onPress={toggleFlag} style={[styles.flagButton, flagged.includes(currentQuestion.id) && styles.flagButtonActive]}>
              <Text style={[styles.flagButtonText, flagged.includes(currentQuestion.id) && styles.flagButtonTextActive]}>{flagged.includes(currentQuestion.id) ? 'FLAGGED' : 'FLAG FOR REVIEW'}</Text>
            </Pressable>
          </View>

          <Text style={styles.questionText}>{currentQuestion.prompt}</Text>
          <Text style={styles.selectHint}>{mode === 'timed' ? 'SELECT ONE ANSWER' : 'CHOOSE AN ANSWER TO CHECK YOUR THINKING'}</Text>

          <View style={styles.optionsList}>
            {currentQuestion.options.map((option, index) => {
              const isSelected = selectedAnswer === index;
              const isCorrect = isAnswerChecked && index === currentQuestion.answer;
              const isWrong = isAnswerChecked && isSelected && !isCorrect;
              return (
                <Pressable
                  key={option}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: isSelected }}
                  onPress={() => !isAnswerChecked && chooseAnswer(index)}
                  style={[styles.option, isSelected && styles.optionSelected, isCorrect && styles.optionCorrect, isWrong && styles.optionWrong]}
                >
                  <View style={[styles.optionLetter, isSelected && styles.optionLetterSelected, isCorrect && styles.optionLetterCorrect, isWrong && styles.optionLetterWrong]}>
                    <Text style={[styles.optionLetterText, (isSelected || isCorrect) && styles.optionLetterTextActive]}>{String.fromCharCode(65 + index)}</Text>
                  </View>
                  <Text style={[styles.optionText, (isSelected || isCorrect) && styles.optionTextActive]}>{option}</Text>
                </Pressable>
              );
            })}
          </View>

          {mode === 'study' && isAnswerChecked && (
            <View style={[styles.explanationBox, selectedAnswer === currentQuestion.answer ? styles.explanationCorrect : styles.explanationReview]}>
              <Text style={[styles.explanationKicker, selectedAnswer === currentQuestion.answer ? styles.explanationKickerCorrect : styles.explanationKickerReview]}>
                {selectedAnswer === currentQuestion.answer ? 'NICE REASONING' : 'REVIEW THE TRADE-OFF'}
              </Text>
              <Text style={styles.explanationText}>{currentQuestion.explanation}</Text>
              <SourceNote source={currentQuestion.source} />
            </View>
          )}

          <View style={styles.questionActions}>
            {questionIndex > 0 ? (
              <Pressable onPress={() => moveQuestion(-1)} style={styles.backButton}><Text style={styles.backButtonText}>Previous</Text></Pressable>
            ) : <View />}
            {mode === 'study' && !isAnswerChecked ? (
              <Pressable disabled={selectedAnswer === undefined} onPress={checkAnswer} style={[styles.actionButton, selectedAnswer === undefined && styles.actionButtonDisabled]}>
                <Text style={styles.actionButtonText}>Check answer</Text>
              </Pressable>
            ) : (
              <Pressable
                onPress={() => moveQuestion(1)}
                style={styles.actionButton}
              >
                <Text style={styles.actionButtonText}>{questionIndex === questions.length - 1 ? 'Finish session' : 'Next question'}</Text>
              </Pressable>
            )}
          </View>
        </ScrollView>
      )}

      {screen === 'results' && (
        <ScrollView contentContainerStyle={styles.resultsContent} showsVerticalScrollIndicator={false}>
          <View style={styles.header}>
            <View style={styles.brandMark}><Text style={styles.brandMarkText}>F</Text></View>
            <View style={styles.brandCopy}><Text style={styles.brandName}>FIELDNOTES</Text><Text style={styles.brandSub}>SESSION REVIEW</Text></View>
            <View style={styles.edition}><Text style={styles.editionText}>01</Text></View>
          </View>
          <Text style={styles.eyebrow}>{mode === 'timed' ? 'SIMULATION COMPLETE' : 'STUDY SESSION COMPLETE'}</Text>
          <Text style={styles.resultsHeadline}>A useful{ '\n'}next step.</Text>
          <View style={styles.scoreCard}>
            <Text style={styles.scoreKicker}>YOUR SCORE</Text>
            <View style={styles.scoreLine}>
              <Text style={styles.scoreValue}>{Math.round((correctCount / questions.length) * 100)}</Text>
              <Text style={styles.scorePercent}>%</Text>
              <View style={styles.scoreDetail}><Text style={styles.scoreDetailMain}>{correctCount} of {questions.length} correct</Text><Text style={styles.scoreDetailSub}>{answeredCount} answered</Text></View>
            </View>
            <View style={styles.scoreRule} />
            <Text style={styles.scoreMessage}>
              {correctCount === questions.length
                ? 'Strong work. Keep testing your reasoning on new scenarios.'
                : 'Review the explanations, then try another set to reinforce the trade-offs.'}
            </Text>
          </View>
          <Text style={styles.sectionTitle}>Review by topic</Text>
          {TOPICS.filter((topic) => questions.some((question) => question.topic === topic)).map((topic) => {
            const topicQuestions = questions.filter((question) => question.topic === topic);
            const topicCorrect = topicQuestions.filter((question) => answers[question.id] === question.answer).length;
            return (
              <View key={topic} style={styles.resultTopic}>
                <View style={styles.resultTopicTop}><Text style={styles.resultTopicName}>{topic}</Text><Text style={styles.resultTopicCount}>{topicCorrect}/{topicQuestions.length}</Text></View>
                <View style={styles.resultTrack}><View style={[styles.resultFill, { width: `${(topicCorrect / topicQuestions.length) * 100}%` }]} /></View>
              </View>
            );
          })}
          <Text style={styles.reviewHeading}>Answer review</Text>
          <View style={styles.reviewList}>
            {questions.map((question, index) => {
              const pickedAnswer = answers[question.id];
              const wasCorrect = pickedAnswer === question.answer;
              return (
                <View key={question.id} style={styles.reviewItem}>
                  <View style={styles.reviewMeta}>
                    <Text style={styles.reviewNumber}>QUESTION {String(index + 1).padStart(2, '0')}</Text>
                    <Text style={[styles.reviewOutcome, wasCorrect ? styles.reviewOutcomeCorrect : styles.reviewOutcomeMissed]}>
                      {wasCorrect ? 'CORRECT' : pickedAnswer === undefined ? 'SKIPPED' : 'REVISIT'}
                    </Text>
                  </View>
                  <Text style={styles.reviewPrompt}>{question.prompt}</Text>
                  <Text style={styles.reviewAnswer}>Best answer: {question.options[question.answer]}</Text>
                  {!wasCorrect && <Text style={styles.reviewYourAnswer}>Your answer: {pickedAnswer === undefined ? 'Not answered' : question.options[pickedAnswer]}</Text>}
                  <Text style={styles.reviewExplanation}>{question.explanation}</Text>
                  <SourceNote source={question.source} />
                </View>
              );
            })}
          </View>
          <View style={styles.resultActions}>
            <Pressable onPress={() => startSession(mode, topicFilter, quickSet)} style={styles.primaryButton}>
              <Text style={styles.primaryButtonText}>Try again</Text><Text style={styles.primaryArrow}>›</Text>
            </Pressable>
            <Pressable onPress={() => { setMode('timed'); setTopicFilter(null); setScreen('home'); }} style={styles.homeButton}>
              <Text style={styles.homeButtonText}>Back to practice desk</Text>
            </Pressable>
          </View>
          {latestResult && <Text style={styles.latestScoreNote}>LATEST RESULT  |  {latestResult.score}%</Text>}
          <Text style={styles.resultsDisclaimer}>Unofficial practice material. This score is for self-study and is not an exam result or certification.</Text>
        </ScrollView>
      )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  homeContent: { paddingHorizontal: 24, paddingTop: 12, paddingBottom: 36 },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 30 },
  brandMark: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.greenDark },
  brandMarkText: { color: COLORS.lime, fontSize: 20, fontWeight: '800' },
  brandCopy: { marginLeft: 11, flex: 1 },
  brandName: { color: COLORS.ink, fontSize: 12, fontWeight: '800', letterSpacing: 1.4 },
  brandSub: { color: COLORS.muted, fontSize: 9, fontWeight: '700', marginTop: 3, letterSpacing: 1.1 },
  edition: { width: 34, height: 34, borderRadius: 17, borderWidth: 1, borderColor: COLORS.line, alignItems: 'center', justifyContent: 'center' },
  editionText: { color: COLORS.muted, fontSize: 11, fontWeight: '700' },
  intro: { marginBottom: 23 },
  eyebrow: { color: COLORS.green, fontSize: 10, fontWeight: '800', letterSpacing: 1.05, marginBottom: 11 },
  headline: { color: COLORS.ink, fontSize: 38, lineHeight: 42, fontWeight: '800', letterSpacing: 0 },
  introText: { color: COLORS.muted, fontSize: 14, lineHeight: 21, marginTop: 11, maxWidth: 310 },
  modeSwitch: { flexDirection: 'row', padding: 4, backgroundColor: '#E8EEE6', borderRadius: 12, marginBottom: 14 },
  modeButton: { flex: 1, alignItems: 'center', justifyContent: 'center', height: 40, borderRadius: 9 },
  modeButtonActive: { backgroundColor: COLORS.paper, shadowColor: '#1E382B', shadowOpacity: 0.07, shadowRadius: 5, shadowOffset: { width: 0, height: 2 }, elevation: 2 },
  modeButtonText: { color: COLORS.muted, fontSize: 12, fontWeight: '700' },
  modeButtonTextActive: { color: COLORS.ink },
  examCard: { borderRadius: 16, backgroundColor: COLORS.greenDark, padding: 20, overflow: 'hidden' },
  examCardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  cardEyebrow: { color: COLORS.lime, fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  examCardTitle: { color: '#FFFFFF', fontSize: 22, fontWeight: '700', marginTop: 8 },
  cardStamp: { borderColor: '#597465', borderWidth: 1, borderRadius: 9, width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  cardStampText: { color: COLORS.lime, fontSize: 12, fontWeight: '700' },
  examCardBody: { color: '#D0DDD4', fontSize: 13, lineHeight: 19, marginTop: 11, maxWidth: 280 },
  lengthSwitch: { flexDirection: 'row', gap: 8, marginTop: 16 },
  lengthButton: { paddingHorizontal: 12, height: 30, borderRadius: 8, borderWidth: 1, borderColor: '#3D5C4E', alignItems: 'center', justifyContent: 'center' },
  lengthButtonActive: { backgroundColor: COLORS.lime, borderColor: COLORS.lime },
  lengthButtonText: { color: '#D0DDD4', fontSize: 11, fontWeight: '700' },
  lengthButtonTextActive: { color: COLORS.greenDark },
  examMetaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 17, marginBottom: 17 },
  examMeta: { color: '#D0DDD4', fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  metaDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: COLORS.orange, marginHorizontal: 10 },
  primaryButton: { minHeight: 50, borderRadius: 10, backgroundColor: COLORS.lime, paddingHorizontal: 15, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  primaryButtonText: { color: COLORS.greenDark, fontSize: 13, fontWeight: '800' },
  primaryArrow: { color: COLORS.greenDark, fontSize: 25, lineHeight: 26, fontWeight: '500' },
  pressed: { opacity: 0.82 },
  quickRow: { minHeight: 74, marginTop: 17, paddingVertical: 14, borderBottomWidth: 1, borderColor: COLORS.line, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  quickCopy: { flex: 1 },
  quickTitle: { color: COLORS.ink, fontSize: 14, fontWeight: '700' },
  quickBody: { color: COLORS.muted, fontSize: 12, marginTop: 4 },
  quickButton: { paddingHorizontal: 13, paddingVertical: 10, borderRadius: 9, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.paper },
  quickButtonText: { color: COLORS.green, fontSize: 11, fontWeight: '800' },
  recentResult: { minHeight: 61, marginTop: 13, paddingHorizontal: 13, paddingVertical: 10, borderRadius: 10, backgroundColor: COLORS.paleGreen, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  recentResultCopy: { flex: 1 },
  recentResultLabel: { color: COLORS.green, fontSize: 8, fontWeight: '800', letterSpacing: 0.8 },
  recentResultTopic: { color: COLORS.ink, fontSize: 11, fontWeight: '700', marginTop: 4 },
  recentResultScore: { color: COLORS.greenDark, fontSize: 20, fontWeight: '800' },
  sectionHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 23, marginBottom: 9 },
  sectionTitle: { color: COLORS.ink, fontSize: 17, fontWeight: '800' },
  sectionNote: { color: COLORS.muted, fontSize: 9, fontWeight: '800', letterSpacing: 0.8 },
  topicList: { backgroundColor: COLORS.paper, borderRadius: 13, borderWidth: 1, borderColor: COLORS.line, paddingHorizontal: 13 },
  topicRow: { flexDirection: 'row', alignItems: 'center', minHeight: 65, borderBottomWidth: 1, borderBottomColor: '#EDF1EC' },
  topicNumber: { width: 32, height: 32, borderRadius: 10, backgroundColor: '#EEF2EC', alignItems: 'center', justifyContent: 'center' },
  topicNumberHighlight: { backgroundColor: COLORS.paleOrange },
  topicNumberText: { color: COLORS.muted, fontSize: 10, fontWeight: '800' },
  topicNumberTextHighlight: { color: '#AF573B' },
  topicCopy: { marginLeft: 11, flex: 1 },
  topicName: { color: COLORS.ink, fontSize: 13, fontWeight: '700' },
  topicCount: { color: COLORS.muted, fontSize: 9, fontWeight: '700', letterSpacing: 0.6, marginTop: 4 },
  topicArrow: { color: COLORS.muted, fontSize: 22, paddingHorizontal: 5 },
  footerNote: { marginTop: 21 },
  footerRule: { width: 27, height: 3, backgroundColor: COLORS.orange, marginBottom: 10 },
  footerText: { color: COLORS.muted, fontSize: 10, lineHeight: 15 },
  examContent: { paddingHorizontal: 22, paddingTop: 10, paddingBottom: 32 },
  examHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 23 },
  closeButton: { width: 38, height: 38, borderRadius: 12, backgroundColor: COLORS.paper, borderWidth: 1, borderColor: COLORS.line, alignItems: 'center', justifyContent: 'center' },
  closeButtonText: { color: COLORS.ink, fontSize: 25, lineHeight: 28, fontWeight: '400' },
  examHeaderCopy: { flex: 1, marginLeft: 11 },
  examHeaderKicker: { color: COLORS.muted, fontSize: 9, fontWeight: '800', letterSpacing: 0.9 },
  examHeaderTitle: { color: COLORS.ink, fontSize: 14, fontWeight: '700', marginTop: 3 },
  timerPill: { paddingHorizontal: 11, height: 34, borderRadius: 9, backgroundColor: COLORS.paleGreen, alignItems: 'center', justifyContent: 'center' },
  timerPillUrgent: { backgroundColor: COLORS.paleOrange },
  timerText: { color: COLORS.green, fontSize: 13, fontWeight: '800', fontVariant: ['tabular-nums'] },
  timerTextUrgent: { color: '#A34E34' },
  timerSpacer: { width: 56 },
  progressInfo: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  progressLabel: { color: COLORS.muted, fontSize: 9, fontWeight: '800', letterSpacing: 0.7 },
  progressDivider: { color: '#AAB5AB' },
  progressTrack: { height: 4, borderRadius: 2, backgroundColor: '#E1E9DF', overflow: 'hidden' },
  progressFill: { height: 4, backgroundColor: COLORS.green, borderRadius: 2 },
  adPauseNotice: { marginTop: 14, paddingHorizontal: 13, paddingVertical: 11, borderRadius: 10, backgroundColor: COLORS.paleGreen },
  adPauseTitle: { color: COLORS.greenDark, fontSize: 11, fontWeight: '800' },
  adPauseText: { color: COLORS.muted, fontSize: 10, marginTop: 3 },
  navigator: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 16, marginBottom: 3 },
  navigatorItem: { width: 30, height: 30, borderRadius: 9, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.paper, alignItems: 'center', justifyContent: 'center' },
  navigatorItemCurrent: { backgroundColor: COLORS.greenDark, borderColor: COLORS.greenDark },
  navigatorItemAnswered: { backgroundColor: COLORS.paleGreen, borderColor: '#C9DCCB' },
  navigatorText: { color: COLORS.muted, fontSize: 10, fontWeight: '700' },
  navigatorTextActive: { color: COLORS.greenDark },
  flagDot: { position: 'absolute', top: -2, right: -2, width: 7, height: 7, borderRadius: 4, backgroundColor: COLORS.orange },
  questionHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 24, marginBottom: 14 },
  topicPill: { backgroundColor: COLORS.paleGreen, paddingHorizontal: 9, paddingVertical: 6, borderRadius: 6 },
  topicPillText: { color: COLORS.green, fontSize: 8, fontWeight: '800', letterSpacing: 0.7 },
  flagButton: { paddingHorizontal: 9, paddingVertical: 7, borderRadius: 7, borderWidth: 1, borderColor: COLORS.line },
  flagButtonActive: { backgroundColor: COLORS.paleOrange, borderColor: '#F0C5B5' },
  flagButtonText: { color: COLORS.muted, fontSize: 8, fontWeight: '800', letterSpacing: 0.4 },
  flagButtonTextActive: { color: '#A34E34' },
  questionText: { color: COLORS.ink, fontSize: 21, lineHeight: 29, fontWeight: '700', letterSpacing: 0 },
  selectHint: { color: COLORS.muted, fontSize: 9, fontWeight: '800', letterSpacing: 0.7, marginTop: 20, marginBottom: 10 },
  optionsList: { gap: 9 },
  option: { minHeight: 57, borderRadius: 11, paddingVertical: 11, paddingHorizontal: 11, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.paper, flexDirection: 'row', alignItems: 'center' },
  optionSelected: { borderColor: '#67957D', backgroundColor: '#F0F6EF' },
  optionCorrect: { borderColor: '#76A789', backgroundColor: '#EAF5EA' },
  optionWrong: { borderColor: '#E6A48C', backgroundColor: '#FFF1EA' },
  optionLetter: { width: 28, height: 28, borderRadius: 8, borderWidth: 1, borderColor: COLORS.line, alignItems: 'center', justifyContent: 'center' },
  optionLetterSelected: { backgroundColor: COLORS.green, borderColor: COLORS.green },
  optionLetterCorrect: { backgroundColor: COLORS.green, borderColor: COLORS.green },
  optionLetterWrong: { backgroundColor: COLORS.orange, borderColor: COLORS.orange },
  optionLetterText: { color: COLORS.muted, fontSize: 10, fontWeight: '800' },
  optionLetterTextActive: { color: COLORS.paper },
  optionText: { color: COLORS.ink, fontSize: 12, lineHeight: 17, flex: 1, marginLeft: 10 },
  optionTextActive: { fontWeight: '600' },
  explanationBox: { marginTop: 13, padding: 14, borderRadius: 11 },
  sourceNote: { marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: 'rgba(25, 51, 43, 0.12)' },
  sourceKicker: { color: COLORS.muted, fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  sourceQuote: { color: COLORS.ink, fontSize: 11, lineHeight: 16, fontStyle: 'italic', marginTop: 5 },
  sourceLink: { color: COLORS.green, fontSize: 11, fontWeight: '700', textDecorationLine: 'underline', marginTop: 6 },
  explanationCorrect: { backgroundColor: COLORS.paleGreen },
  explanationReview: { backgroundColor: COLORS.paleOrange },
  explanationKicker: { fontSize: 9, fontWeight: '800', letterSpacing: 0.7, marginBottom: 7 },
  explanationKickerCorrect: { color: COLORS.green },
  explanationKickerReview: { color: '#A34E34' },
  explanationText: { color: COLORS.ink, fontSize: 12, lineHeight: 18 },
  questionActions: { marginTop: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  backButton: { minHeight: 46, justifyContent: 'center', paddingHorizontal: 5 },
  backButtonText: { color: COLORS.green, fontSize: 12, fontWeight: '700' },
  actionButton: { minHeight: 46, paddingHorizontal: 17, borderRadius: 9, backgroundColor: COLORS.greenDark, alignItems: 'center', justifyContent: 'center' },
  actionButtonDisabled: { opacity: 0.4 },
  actionButtonText: { color: COLORS.paper, fontSize: 12, fontWeight: '800' },
  resultsContent: { paddingHorizontal: 24, paddingTop: 12, paddingBottom: 38 },
  resultsHeadline: { color: COLORS.ink, fontSize: 37, lineHeight: 41, fontWeight: '800', marginBottom: 19 },
  scoreCard: { backgroundColor: COLORS.greenDark, borderRadius: 16, padding: 20, marginBottom: 25 },
  scoreKicker: { color: COLORS.lime, fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  scoreLine: { flexDirection: 'row', alignItems: 'center', marginTop: 8 },
  scoreValue: { color: COLORS.paper, fontSize: 58, lineHeight: 64, fontWeight: '800' },
  scorePercent: { color: COLORS.lime, fontSize: 21, fontWeight: '700', alignSelf: 'flex-start', marginTop: 10 },
  scoreDetail: { marginLeft: 15, marginTop: 9 },
  scoreDetailMain: { color: COLORS.paper, fontSize: 12, fontWeight: '700' },
  scoreDetailSub: { color: '#B6C8BD', fontSize: 10, marginTop: 4 },
  scoreRule: { height: 1, backgroundColor: '#486355', marginVertical: 12 },
  scoreMessage: { color: '#D0DDD4', fontSize: 12, lineHeight: 18 },
  resultTopic: { paddingVertical: 12, borderBottomWidth: 1, borderColor: COLORS.line },
  resultTopicTop: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  resultTopicName: { color: COLORS.ink, fontSize: 12, fontWeight: '700' },
  resultTopicCount: { color: COLORS.muted, fontSize: 11, fontWeight: '700' },
  resultTrack: { height: 4, backgroundColor: '#E3EAE1', borderRadius: 2, overflow: 'hidden' },
  resultFill: { height: 4, backgroundColor: COLORS.orange, borderRadius: 2 },
  reviewHeading: { color: COLORS.ink, fontSize: 17, fontWeight: '800', marginTop: 25, marginBottom: 10 },
  reviewList: { backgroundColor: COLORS.paper, borderWidth: 1, borderColor: COLORS.line, borderRadius: 12, paddingHorizontal: 13 },
  reviewItem: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: COLORS.line },
  reviewMeta: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  reviewNumber: { color: COLORS.muted, fontSize: 8, fontWeight: '800', letterSpacing: 0.7 },
  reviewOutcome: { fontSize: 8, fontWeight: '800', letterSpacing: 0.6 },
  reviewOutcomeCorrect: { color: COLORS.green },
  reviewOutcomeMissed: { color: '#AF573B' },
  reviewPrompt: { color: COLORS.ink, fontSize: 12, lineHeight: 18, fontWeight: '700' },
  reviewAnswer: { color: COLORS.green, fontSize: 11, lineHeight: 16, fontWeight: '700', marginTop: 8 },
  reviewYourAnswer: { color: '#AF573B', fontSize: 11, lineHeight: 16, marginTop: 3 },
  reviewExplanation: { color: COLORS.muted, fontSize: 11, lineHeight: 16, marginTop: 7 },
  resultActions: { gap: 9, marginTop: 23 },
  homeButton: { minHeight: 46, borderRadius: 9, borderWidth: 1, borderColor: COLORS.line, alignItems: 'center', justifyContent: 'center' },
  homeButtonText: { color: COLORS.green, fontSize: 12, fontWeight: '700' },
  latestScoreNote: { marginTop: 17, color: COLORS.muted, fontSize: 9, fontWeight: '800', letterSpacing: 0.7 },
  resultsDisclaimer: { color: COLORS.muted, fontSize: 10, lineHeight: 15, marginTop: 13 },
});
