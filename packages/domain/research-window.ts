/** A research window is frozen at task creation, never recalculated from execution time. */
export function frozenResearchWindow(createdAt: string, windowDays: number) {
  const endMs = Date.parse(createdAt);
  const days = Math.max(1, Math.min(365, Number.isFinite(windowDays) ? windowDays : 7));
  const startMs = endMs - days * 86_400_000;
  if (!Number.isFinite(endMs)) throw new Error('任务创建时间无效，无法计算冻结研究窗口');
  const localDate = (ms: number) => {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ms);
    const part = (type: string) => parts.find(value => value.type === type)?.value || '';
    return `${part('year')}-${part('month')}-${part('day')}`;
  };
  const localDateTime = (ms: number) => new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(ms);
  return {
    start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), days,
    start_date: localDate(startMs), end_date: localDate(endMs),
    start_local: localDateTime(startMs), end_local: localDateTime(endMs), timezone: 'Asia/Shanghai',
  };
}

export function rejectMismatchedTitleWindow(title: string, window: ReturnType<typeof frozenResearchWindow>) {
  // Only validate an explicit date range in a report title. Historical dates inside analysis remain valid.
  const match = title.match(/(20\d{2})年(\d{1,2})月(\d{1,2})日\s*[-–—至]\s*(?:(20\d{2})年)?(?:(\d{1,2})月)?(\d{1,2})日/);
  if (!match) return;
  const start = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  const end = `${match[4] || match[1]}-${(match[5] || match[2]).padStart(2, '0')}-${match[6].padStart(2, '0')}`;
  if (start !== window.start_date || end !== window.end_date) {
    throw new Error(`报告标题日期 ${start} 至 ${end} 与任务冻结窗口 ${window.start_date} 至 ${window.end_date} 不一致；请修正标题，历史背景日期可保留在正文`);
  }
}
