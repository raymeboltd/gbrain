/** Typed reason reserved for the cycle wrapper's own per-source deadline. */
export class ConversationFactsDeadlineExceeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversationFactsDeadlineExceeded';
  }
}
