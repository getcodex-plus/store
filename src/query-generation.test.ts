import { describe, expect, it } from 'vitest'
import { createQueryGeneration } from './query-generation'

describe('query generation', () => {
  it('drops a response whose generation was superseded by a filter change', () => {
    const generation = createQueryGeneration()

    const fullList = generation.start()
    const filtered = generation.start()

    // The full-list request resolves last, but it must not repaint the table.
    expect(generation.isCurrent(fullList)).toBe(false)
    expect(generation.isCurrent(filtered)).toBe(true)
  })

  it('drops a page request issued before a refresh so it cannot append foreign rows', () => {
    const generation = createQueryGeneration()

    generation.start()
    const page = generation.ticket() // loadMore follows the current generation

    generation.start() // refresh / filter change happens while the page is in flight

    expect(generation.isCurrent(page)).toBe(false)
  })

  it('keeps a page request valid while no refresh happened', () => {
    const generation = createQueryGeneration()

    generation.start()
    const first = generation.ticket()
    const second = generation.ticket()

    // Two page requests of the same generation both apply; order between them is
    // the appending code's business, not a generation concern.
    expect(generation.isCurrent(first)).toBe(true)
    expect(generation.isCurrent(second)).toBe(true)
  })
})
