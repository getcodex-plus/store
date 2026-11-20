// Guards a list view against out-of-order responses.
//
// A refresh or filter change starts a new generation. Any response that belongs
// to an older generation is dropped instead of being rendered: without this, a
// slow full-list request can land after a faster filtered one and repaint the
// table with rows that do not match the selector, and a page request issued
// before a refresh can append rows of an unrelated state.
export function createQueryGeneration() {
  let current = 0
  return {
    /** Start a new generation (refresh, filter change) and return its ticket. */
    start: () => {
      current += 1
      return current
    },
    /** Ticket of the generation in flight, for requests that follow the current one. */
    ticket: () => current,
    /** Whether a response carrying this ticket should still be applied. */
    isCurrent: (ticket: number) => ticket === current,
  }
}

export type QueryGeneration = ReturnType<typeof createQueryGeneration>
