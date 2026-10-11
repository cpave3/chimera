export interface QuestionOption {
  label: string;
  /** What choosing this option means, when the label does not say it all. */
  description?: string;
}

export interface Question {
  question: string;
  /** A short label for the question, shown where space is tight. */
  header?: string;
  options: QuestionOption[];
}

/** Questions the model put to the user in one `ask_question` call. */
export interface QuestionRequest {
  requestId: string;
  questions: Question[];
}

export interface QuestionAnswer {
  /** The text of the question this answers. */
  question: string;
  /** The label of the chosen option, or the text the user typed. */
  answer: string;
  /** True when the user typed an answer of their own. */
  custom: boolean;
}

/** How a `QuestionRequest` ended: with answers, or with the user declining. */
export type QuestionResolution =
  | { status: 'answered'; answers: QuestionAnswer[] }
  | { status: 'cancelled' };

export const QUESTION_LIMITS = {
  minQuestions: 1,
  maxQuestions: 4,
  minOptions: 2,
  maxOptions: 4,
} as const;
