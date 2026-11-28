// The Quality pane: the latest result of every dbt test (data tests and unit tests), problems
// first and grouped by the node they test, with buttons to run tests, re-run the failing ones,
// query what a failing test found, and draw the affected nodes in the graph.
import { selectorTerm } from '../src/graph'
import type { NodeSummary, QualityReport, TestResult, TestStatus } from '../src/protocol'
import { age, button, el, emptyState, fill, flagTitle, freshnessItem, isProblem, plural, sectionHead, STATUS_LABELS, statusTag, swatch } from './dom'
import { icon } from './icons'

export type QualityViewEvents = {
  /** Run `dbt test`: on a selector, these tests, or (neither) every test. */
  run(wanted: { selector?: string; testIds?: string[] }): void
  cancel(jobId: string): void
  /** Show the node in the details pane. */
  show(id: string): void
  /** Show the node and query the rows test `testId` found. */
  rows(nodeId: string, testId: string): void
  /** Draw these nodes in the graph (as a dbt selector). */
  draw(selector: string): void
  /** List every test (true) or only problems. */
  listAll(all: boolean): void
  /** Run `dbt source freshness` on every source with a rule. */
  checkFreshness(): void
}

const SECOND = 1000

export class QualityView {
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly root: HTMLElement,
    private readonly events: QualityViewEvents
  ) {}

  showMessage(title: string, text: string | undefined, tone: 'muted' | 'warning'): void {
    clearInterval(this.timer)
    fill(this.root, el('div', { class: 'pane-body' }, emptyState(tone === 'warning' ? 'alert' : 'quality', title, text, null, tone)))
  }

  /** The report; `selector` is the page's, offered as "Test selection"; `error` a failed run's. */
  show(report: QualityReport, options: { all: boolean; selector: string; error: string | null }): void {
    clearInterval(this.timer)
    const { counts } = report
    const total = counts.error + counts.fail + counts.warn + counts.skipped + counts.pass + counts.never
    const problems = report.tests.filter((test) => isProblem(test.status))
    const failing = report.tests.filter((test) => test.status === 'error' || test.status === 'fail')
    const affected = [...new Map(problems.flatMap((test) => (test.node ? [[test.node.id, test.node]] : []))).values()]

    const filter = el(
      'div',
      { class: 'segmented', role: 'tablist' },
      ...([
        [false, 'Problems'],
        [true, 'All tests']
      ] as const).map(([all, label]) => {
        const option = button(label, () => all !== options.all && this.events.listAll(all), { small: true, class: all === options.all ? 'active' : '' })
        option.setAttribute('aria-pressed', String(all === options.all))
        return option
      })
    )

    fill(
      this.root,
      el(
        'div',
        { class: 'pane-head' },
        el('h2', {}, 'Quality'),
        el('span', { class: 'pane-head-meta' }, report.lastRun ? `Last run ${age(report.lastRun)}` : 'No runs yet'),
        el('span', { class: 'spacer' })
      ),
      el(
        'div',
        { class: 'pane-body' },
        total === 0
          ? emptyState('quality', 'No tests yet', 'Add data tests to your YAML or unit tests, and their results show up here.')
          : el(
              'div',
              { class: 'stat-grid' },
              stat(counts.error + counts.fail, 'failing', counts.error + counts.fail > 0 ? 'bad' : ''),
              stat(counts.warn, 'warnings', counts.warn > 0 ? 'warn' : ''),
              stat(counts.pass, 'passing', counts.pass > 0 ? 'ok' : ''),
              stat(counts.never + counts.skipped, counts.skipped > 0 ? 'not run / skipped' : 'never run')
            ),
        total > 0 || report.running ? this.runBar(report, options.selector, failing, total) : null,
        options.error ? el('div', { class: 'callout danger' }, icon('alert', 14), el('pre', {}, options.error)) : null,
        total > 0 && counts.never === total
          ? el('p', { class: 'pane-note' }, 'No results yet. Run the tests here, or `dbt test` in a terminal: the results show up here either way.')
          : null,
        total > 0
          ? el(
              'div',
              { class: 'list-tools' },
              filter,
              el('span', { class: 'spacer' }),
              affected.length > 0
                ? button(`Draw ${affected.length} in graph`, () => this.events.draw(affected.map((node) => selectorTerm(node)).join(' ')), {
                    variant: 'ghost',
                    small: true,
                    icon: 'graph',
                    title: 'Draw the nodes with problems in the graph'
                  })
                : null
            )
          : null,
        report.tests.length > 0
          ? this.groups(report.tests, report.flags)
          : total > 0 && counts.never < total && !options.all
            ? emptyState('check', 'All clear', 'No failing, erroring or warning tests in the latest results.')
            : null,
        report.more > 0 ? el('p', { class: 'pane-note' }, `${report.more} more not listed.`) : null,
        this.freshness(report, options.all)
      )
    )
  }

  /**
   * Source freshness: the stale, late and failed sources (every source with `all`), a line that
   * counts the rest, and a button to check again. Nothing when no source has a freshness rule.
   */
  private freshness(report: QualityReport, all: boolean): HTMLElement | null {
    const { counts, checkedAt, sources } = report.freshness
    const withRule = counts.error + counts.fail + counts.warn + counts.pass + counts.never
    if (withRule === 0) return null
    const problems = counts.error + counts.fail + counts.warn
    const rest = all
      ? []
      : [counts.pass > 0 ? `${counts.pass} fresh` : null, counts.never > 0 ? `${counts.never} not checked yet` : null].filter(Boolean)
    return el(
      'section',
      { class: 'block freshness' },
      sectionHead(
        'Source freshness',
        problems > 0 ? problems : null,
        button('Check', () => this.events.checkFreshness(), {
          small: true,
          icon: 'refresh',
          disabled: report.running !== null,
          title: 'dbt source freshness'
        })
      ),
      sources.length > 0 ? el('ul', { class: 'test-list' }, ...sources.map((source) => freshnessItem(source, () => this.events.show(source.node.id)))) : null,
      el('p', { class: 'pane-note' }, [...rest, checkedAt ? `checked ${age(checkedAt)}` : 'never checked'].join(' · '))
    )
  }

  private runBar(report: QualityReport, selector: string, failing: readonly TestResult[], total: number): HTMLElement {
    const running = report.running
    if (running) {
      const elapsed = el('span', { class: 'mono muted' })
      const tick = () => (elapsed.textContent = clock(Date.now() - running.startedAt))
      tick()
      this.timer = setInterval(tick, SECOND)
      return el(
        'div',
        { class: 'run-bar running' },
        el('span', { class: 'spinner' }),
        el('span', { class: 'run-label' }, `Running ${running.label}`),
        elapsed,
        el('span', { class: 'spacer' }),
        button('Cancel', () => this.events.cancel(running.jobId), { small: true, icon: 'stop' })
      )
    }
    if (total === 0) return el('div', {})
    return el(
      'div',
      { class: 'run-bar' },
      button('Run all tests', () => this.events.run({}), { variant: 'primary', small: true, icon: 'play' }),
      failing.length > 0 ? button(`Re-run ${failing.length} failing`, () => this.events.run({ testIds: failing.map((test) => test.id) }), { small: true, icon: 'refresh' }) : null,
      selector ? button('Test selection', () => this.events.run({ selector }), { small: true, title: `dbt test --select ${selector}` }) : null
    )
  }

  /** The tests under the node each tests, nodes in the order of their worst test. */
  private groups(tests: readonly TestResult[], flags: QualityReport['flags']): HTMLElement {
    const groups = new Map<string, { node: NodeSummary | null; tests: TestResult[] }>()
    for (const test of tests) {
      const key = test.node?.id ?? ''
      const group = groups.get(key) ?? { node: test.node, tests: [] }
      group.tests.push(test)
      groups.set(key, group)
    }
    return el(
      'div',
      { class: 'test-groups' },
      ...[...groups.values()].map(({ node, tests: nodeTests }) => {
        const flag = node ? flags[node.id] : undefined
        const head = node
          ? el(
              'button',
              { type: 'button', class: 'row node group-head', title: node.id, 'data-id': node.id },
              swatch(node.type),
              el('span', { class: 'label' }, node.name),
              el('span', { class: 'row-end' }, flag ? statusTag(flag.status, flagTitle(flag)) : null, el('span', { class: 'row-count' }, String(nodeTests.length)))
            )
          : el('div', { class: 'row group-head muted' }, el('span', { class: 'label' }, 'Not attached to a node'))
        if (node) head.addEventListener('click', () => this.events.show(node.id))
        return el('section', { class: 'test-group' }, head, el('ul', { class: 'test-list' }, ...nodeTests.map((test) => this.testRow(test))))
      })
    )
  }

  private testRow(test: TestResult): HTMLLIElement {
    return testItem(test, test.rows && test.node ? () => this.events.rows(test.node!.id, test.id) : null)
  }
}

/** One test: status, name, column, rows found, and a button to query those rows. */
export function testItem(test: TestResult, showRows: (() => void) | null): HTMLLIElement {
  const found =
    test.failures !== null && test.failures > 0 && test.status !== 'pass' ? el('span', { class: 'test-found' }, plural(test.failures, 'row')) : null
  // "Got 2 results, configured to fail if != 0" only repeats the count; errors and unit test
  // diffs say something.
  const message =
    test.message && (test.status === 'error' || test.kind === 'unit' || !/^Got \d+ results?, configured to/.test(test.message))
      ? el('pre', { class: 'test-message' }, test.message)
      : null
  return el(
    'li',
    { class: `test-item status-${test.status ?? 'never'}`, title: [test.name, test.ms === null ? '' : `${(test.ms / 1000).toFixed(1)} s`, test.status ? STATUS_LABELS[test.status as TestStatus] : 'never run'].filter(Boolean).join(' · ') },
    el(
      'div',
      { class: 'test-row' },
      statusTag(test.status),
      el(
        'span',
        { class: 'test-text' },
        el('span', { class: 'test-label' }, test.kind === 'unit' ? el('span', { class: 'kind' }, 'unit') : null, test.label),
        test.column ? el('code', { class: 'test-column' }, test.column) : null
      ),
      found,
      showRows ? button('Rows', showRows, { variant: 'ghost', small: true, title: 'Query the rows this test found' }) : null
    ),
    message
  )
}

function stat(value: number, label: string, tone = ''): HTMLElement {
  return el('div', { class: `stat ${tone}` }, el('span', { class: 'stat-value' }, value.toLocaleString()), el('span', { class: 'stat-label' }, label))
}

function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
