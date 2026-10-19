// Server-sent events over a streamed fetch: EventSource cannot send an
// Authorization header, and a token in a URL ends up in logs and in OBS's
// settings, so the stream is read as bytes and parsed here, per the WHATWG
// rules (fields `event`, `data`, `id`, `retry`; a blank line dispatches; a
// line starting with a colon is a comment).

export interface SseFrame {
  /** The `event` field, or `message`. */
  event: string;
  data: string;
  /** The `id` field of this frame, when it had one. */
  id: string | null;
  /** A `retry` field, in milliseconds. */
  retry: number | null;
}

/** Feed text as it arrives; complete frames come out. */
export class SseParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];
  private id: string | null = null;
  private retry: number | null = null;
  private seenField = false;

  push(text: string): SseFrame[] {
    this.buffer += text;
    const frames: SseFrame[] = [];
    let start = 0;
    for (;;) {
      const lf = this.buffer.indexOf('\n', start);
      const cr = this.buffer.indexOf('\r', start);
      let end: number;
      let next: number;
      if (cr !== -1 && (lf === -1 || cr < lf)) {
        // A CR at the end of the buffer may be the first half of a CRLF still in flight.
        if (cr === this.buffer.length - 1) break;
        end = cr;
        next = this.buffer[cr + 1] === '\n' ? cr + 2 : cr + 1;
      } else if (lf !== -1) {
        end = lf;
        next = lf + 1;
      } else {
        break;
      }
      const frame = this.line(this.buffer.slice(start, end));
      if (frame) frames.push(frame);
      start = next;
    }
    this.buffer = this.buffer.slice(start);
    return frames;
  }

  private line(line: string): SseFrame | null {
    if (line === '') {
      if (!this.seenField) return null;
      const frame: SseFrame = { event: this.event || 'message', data: this.data.join('\n'), id: this.id, retry: this.retry };
      this.event = '';
      this.data = [];
      this.id = null;
      this.retry = null;
      this.seenField = false;
      return frame;
    }
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event':
        this.event = value;
        break;
      case 'data':
        this.data.push(value);
        break;
      case 'id':
        if (!value.includes('\0')) this.id = value;
        break;
      case 'retry':
        if (/^\d+$/.test(value)) this.retry = Number(value);
        break;
      default:
        return null;
    }
    this.seenField = true;
    return null;
  }
}
