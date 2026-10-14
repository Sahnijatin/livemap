type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

function messageText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((p): p is Obj => isObj(p) && (p.type === 'output_text' || p.type === 'text') && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('');
}

/** Text of the latest assistant message in a Codex rollout tail; unknown or malformed lines are skipped. */
export function lastCodexAssistantText(jsonlTail: string): string | null {
  const lines = jsonlTail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let o: unknown;
    try { o = JSON.parse(line); } catch { continue; }
    if (!isObj(o) || !isObj(o.payload)) continue;
    const p = o.payload;
    let text = '';
    if (o.type === 'response_item' && p.type === 'message' && p.role === 'assistant') text = messageText(p.content);
    else if (o.type === 'event_msg' && p.type === 'agent_message' && typeof p.message === 'string') text = p.message;
    if (text) return text;
  }
  return null;
}
