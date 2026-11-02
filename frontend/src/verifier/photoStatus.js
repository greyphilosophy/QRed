export function photoProcessingMessage(progress) {
  return Number.isFinite(progress) && progress >= 0 && progress < 1
    ? `Photo captured — processing ${Math.floor(progress * 100)}% completed`
    : "Photo captured — processing…";
}
