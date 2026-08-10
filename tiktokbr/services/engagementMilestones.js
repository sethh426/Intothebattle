export const LIKE_BURST_THRESHOLD = 1000;
export const LIKE_STANDARD_THRESHOLD = 100;

export function buildFullScreenLikeBurstEffect(milestone, options = {}) {
  const value = Math.max(LIKE_BURST_THRESHOLD, Math.round(Number(milestone) || LIKE_BURST_THRESHOLD));
  return {
    id: `likes:${value}`,
    trigger: 'likes',
    threshold: LIKE_BURST_THRESHOLD,
    effect: 'particleForm',
    shape: options.shape || 'heart',
    text: options.text || '+1,000 LIKES',
    duration: Math.max(900, Math.round(Number(options.duration) || 2800)),
    cooldown: Math.max(0, Math.round(Number(options.cooldown) || 5000)),
    milestone: value,
    totalLikes: Math.max(value, Math.round(Number(options.totalLikes) || value)),
  };
}

export function normalizeLikeStats(stats = {}) {
  if (!stats || typeof stats !== 'object') {
    return { total: 0, lastMilestone: 0, lastFullScreenMilestone: 0 };
  }
  return {
    ...stats,
    total: Math.max(0, Math.round(Number(stats.total) || 0)),
    lastMilestone: Math.max(0, Math.round(Number(stats.lastMilestone) || 0)),
    lastFullScreenMilestone: Math.max(0, Math.round(Number(stats.lastFullScreenMilestone) || 0)),
  };
}

export function updateLikeMilestones(stats = {}, increment = 1, options = {}) {
  const nextStats = normalizeLikeStats(stats);
  const step = Math.max(1, Math.round(Number(increment) || 1));
  const previous = nextStats.total;
  const total = previous + step;
  nextStats.total = total;

  const previousHundred = Math.floor(previous / LIKE_STANDARD_THRESHOLD);
  const currentHundred = Math.floor(total / LIKE_STANDARD_THRESHOLD);
  const crossedHundreds = [];
  for (let mark = previousHundred + 1; mark <= currentHundred; mark += 1) {
    crossedHundreds.push(mark * LIKE_STANDARD_THRESHOLD);
  }

  const previousFullScreen = Math.max(
    nextStats.lastFullScreenMilestone,
    Math.floor(previous / LIKE_BURST_THRESHOLD) * LIKE_BURST_THRESHOLD
  );
  const currentFullScreen = Math.floor(total / LIKE_BURST_THRESHOLD) * LIKE_BURST_THRESHOLD;
  const fullScreenMilestones = [];
  for (let mark = Math.max(LIKE_BURST_THRESHOLD, previousFullScreen + LIKE_BURST_THRESHOLD); mark <= currentFullScreen; mark += LIKE_BURST_THRESHOLD) {
    fullScreenMilestones.push(mark);
  }
  if (fullScreenMilestones.length) {
    nextStats.lastFullScreenMilestone = fullScreenMilestones[fullScreenMilestones.length - 1];
  }

  const fullScreenEffects = fullScreenMilestones.map(milestone => buildFullScreenLikeBurstEffect(milestone, {
    ...options,
    totalLikes: total,
  }));
  const milestone = fullScreenMilestones.length
    ? fullScreenMilestones[fullScreenMilestones.length - 1]
    : crossedHundreds.length
      ? crossedHundreds[crossedHundreds.length - 1]
      : null;
  if (milestone) nextStats.lastMilestone = milestone;

  return {
    stats: nextStats,
    total,
    milestone,
    milestones: crossedHundreds,
    fullScreenMilestones,
    fullScreenEffects,
    tier: fullScreenMilestones.length || (milestone && milestone % LIKE_BURST_THRESHOLD === 0) ? 'mega' : milestone ? 'standard' : null,
  };
}
