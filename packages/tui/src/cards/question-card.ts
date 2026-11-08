import type { QuestionAnswer, QuestionRequest, QuestionResolution } from '@chimera/core';
import { wrapText } from '../ledger/text';
import type { InputEvent } from '../terminal/keys';
import { sanitizeDeep, sanitizeText } from '../terminal/sanitize';
import type { Style } from '../theme/style';
import { type Card, cardInnerWidth, renderCard } from './card';

const OWN_ANSWER = 'Type an answer…';

/**
 * The questions of one `ask_question` call, one at a time: answered by
 * number, by ↑↓ and Enter, or by typing. The answers go out together after
 * the last one; Esc declines them all.
 */
export class QuestionCard implements Card {
  private answers: QuestionAnswer[] = [];
  private selected = 0;
  /** The text so far while the user types an answer; null while they pick. */
  private typed: string | null = null;

  constructor(
    private readonly request: QuestionRequest,
    private readonly onResolve: (resolution: QuestionResolution) => void,
  ) {}

  private get question() {
    return this.request.questions[this.answers.length];
  }

  private answer(text: string, custom: boolean): void {
    const asked = this.question;
    if (!asked) return;
    this.answers = [...this.answers, { question: asked.question, answer: text, custom }];
    this.selected = 0;
    this.typed = null;
    if (this.answers.length === this.request.questions.length) {
      this.onResolve({ status: 'answered', answers: this.answers });
    }
  }

  private choose(row: number): void {
    const asked = this.question;
    if (!asked) return;
    const option = asked.options[row];
    if (option) this.answer(option.label, false);
    else if (row === asked.options.length) this.typed = '';
  }

  handleKey(event: InputEvent): void {
    const asked = this.question;
    if (!asked) return;
    const rows = asked.options.length + 1;
    if (event.type === 'paste') {
      this.typed = (this.typed ?? '') + event.text.replace(/\n/g, ' ');
      return;
    }
    if (event.type !== 'key') return;
    if (this.typed !== null) {
      if (event.name === 'enter') {
        if (this.typed.trim() !== '') this.answer(this.typed.trim(), true);
      } else if (event.name === 'escape') {
        this.typed = null;
      } else if (event.name === 'backspace') {
        this.typed = this.typed.slice(0, -1);
      } else if (event.text !== undefined) {
        this.typed += event.text;
      }
      return;
    }
    if (event.name === 'up') this.selected = (this.selected + rows - 1) % rows;
    else if (event.name === 'down') this.selected = (this.selected + 1) % rows;
    else if (event.name === 'enter') this.choose(this.selected);
    else if (event.name === 'escape') this.onResolve({ status: 'cancelled' });
    else if (event.text !== undefined) {
      const number = Number(event.text);
      if (/^[1-9]$/.test(event.text) && number <= rows) this.choose(number - 1);
      else if (event.text.trim() !== '') this.typed = event.text;
    }
  }

  render(width: number, maxRows: number, style: Style): string[] {
    if (!this.question) return [];
    const asked = sanitizeDeep(this.question);
    const inner = cardInnerWidth(width);
    const total = this.request.questions.length;
    const title = [
      'question',
      asked.header,
      total > 1 ? `${this.answers.length + 1} of ${total}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const body = wrapText(asked.question, inner);
    const choices = asked.options.map((option, index) => {
      const highlighted = this.typed === null && index === this.selected;
      const marker = highlighted ? style.fg('accent', '› ') : '  ';
      const label = `${index + 1}. ${option.label}`;
      return `${marker}${highlighted ? style.bold(label) : label}${option.description ? `  ${style.fg('dim', option.description)}` : ''}`;
    });
    const ownRow = asked.options.length;
    if (this.typed === null) {
      const highlighted = this.selected === ownRow;
      const label = `${ownRow + 1}. ${OWN_ANSWER}`;
      choices.push(
        `${highlighted ? style.fg('accent', '› ') : '  '}${highlighted ? style.bold(label) : style.fg('muted', label)}`,
      );
    } else {
      choices.push(`${style.fg('accent', '› ')}${sanitizeText(this.typed)}${style.inverse(' ')}`);
    }
    const keys =
      this.typed === null
        ? `1-${ownRow + 1} or ↑↓ enter · type to answer · esc skip`
        : 'enter answer · esc back';
    return renderCard(
      { title, tone: 'info', keys, body, footer: ['', ...choices] },
      width,
      maxRows,
      style,
    );
  }
}
