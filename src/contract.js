// Shared contract between the backend and frontend of the RevisionHub past-paper plugin.
// This is plain JS (no build step needed). Keep it importable from both ESM (main.js) and CJS (backend.cjs)
// by avoiding dependencies and using a global-free module pattern.

export const PLUGIN_ID = "revisionhub-pastpapers";
export const QUESTION_TYPE_ID = "rh-pastpaper";
export const TEACH_TOOL_NAME = "ask_rh_pastpaper_question";
export const FETCH_TOOL_NAME = "fetch_rh_pastpaper";

export const SETTINGS_FILE = "settings.json";
export const PAPERS_FILE = "papers.json";

export const DEFAULT_BASE_URL = "https://revisionhub.study";

// JSON Schema for the payload the teacher supplies when posing a past-paper question.
// The host builds the native posing tool from this schema, so keep fields self-contained and persistable.
export const questionSchema = {
  type: "object",
  properties: {
    question: {
      type: "string",
      minLength: 1,
      description:
        "Learner-visible question text in Markdown. Keep the exact exam wording here. This is the teaser/fallback shown when the custom renderer is unavailable.",
    },
    sourceUrl: {
      type: "string",
      description:
        "RevisionHub URL the question came from, e.g. https://revisionhub.study/question/123 or a paper page URL. Used for attribution and re-fetching.",
    },
    subject: {
      type: "string",
      description: "Subject name such as 'Mathematics Analysis and Approaches' or 'Biology'. Optional but recommended.",
    },
    paper: {
      type: "string",
      description:
        "Paper reference such as '2024-May-Paper1-HL' or the paper page slug when known. Optional.",
    },
    topic: {
      type: "string",
      description: "Topic or sub-topic classification from RevisionHub. Optional but recommended.",
    },
    markscheme: {
      type: "string",
      description:
        "Mark scheme / answer guidance from RevisionHub, as Markdown. Kept in the payload so it is preserved with the question and revealed only in the answered transcript. Optional.",
    },
  },
  required: ["question"],
  additionalProperties: false,
};

export const answerSchema = { type: "string", minLength: 1 };

export const questionTypeDefinition = {
  id: QUESTION_TYPE_ID,
  label: "RevisionHub past-paper question",
  contractVersion: 1,
  showThinking: true,
  questionSchema,
  answerSchema,
  teach: {
    toolName: TEACH_TOOL_NAME,
    description:
      "Ask the learner a past-paper question sourced from RevisionHub. Supply the learner-visible 'question' text in Markdown and, when available, 'sourceUrl', 'subject', 'paper', 'topic' and 'markscheme'. The mark scheme is preserved with the question and revealed only after the learner answers.",
  },
  validateQuestion({ input }) {
    const errors = [];
    const payload = input && input.payload;
    if (!payload || typeof payload !== "object") {
      errors.push("A payload object with a 'question' string is required.");
      return errors;
    }
    if (typeof payload.question !== "string" || !payload.question.trim()) {
      errors.push("payload.question must contain non-whitespace text.");
    }
    if (payload.sourceUrl !== undefined) {
      if (typeof payload.sourceUrl !== "string") errors.push("payload.sourceUrl must be a string.");
      else if (!isAllowedRevisionHubUrl(payload.sourceUrl)) {
        errors.push("payload.sourceUrl must be a https://revisionhub.study URL.");
      }
    }
    return errors.length ? errors : undefined;
  },
};

export function isAllowedRevisionHubUrl(raw) {
  if (typeof raw !== "string") return false;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return false;
    return u.hostname === "revisionhub.study" || u.hostname.endsWith(".revisionhub.study");
  } catch {
    return false;
  }
}

export const TEACHER_INSTRUCTIONS = [
  "A RevisionHub past-paper integration is available.",
  "When the lesson calls for an IB past-paper or exam-style question, use fetch_rh_pastpaper to retrieve one before posing it.",
  "fetch_rh_pastpaper accepts either a RevisionHub URL (a /question/:id page or a /ib/.../papers page), a bare question id, or a search topic with subject.",
  "The tool returns the question text and mark scheme when your RevisionHub session is configured. If it reports that no session is configured, ask the learner to open the plugin's Settings view and paste their RevisionHub session cookie, or ask them to paste the past-paper text directly and then continue.",
  "After fetching, pose exactly one question using the ask_rh_pastpaper_question tool. Put the exam wording in the 'question' field and the mark scheme in the 'markscheme' field. Include sourceUrl, subject, paper and topic when known.",
  "Never invent a source URL or claim a question came from RevisionHub if the fetch failed. If no source could be retrieved, follow your normal teaching flow instead.",
  "The mark scheme is revealed only after the learner answers; do not show it in your teaching text before the question is posed.",
].join(" ");
