export function tailLines(text: string, maxLines: number): string {
  if (text === "") return "";
  const limit = maxLines > 0 ? maxLines : 1;
  const lines = text.split("\n");
  if (lines.length <= limit) return text;
  const dropped = lines.length - limit;
  const kept = lines.slice(dropped);
  return `… (${dropped} earlier lines omitted)\n${kept.join("\n")}`;
}
