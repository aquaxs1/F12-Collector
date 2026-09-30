// WebSockets / EventSource: connections and their frames/messages, captured by the MAIN-world
// probe (window.WebSocket / window.EventSource wrappers) from document_start in every frame.
// Works in Chrome and Firefox. Message text is redacted by default.
import type { Collector } from '@/lib/context';
import { json } from '@/lib/context';
import { redactTokensInString } from '@/lib/redact';
import type { WsConnection } from '@/lib/types';

export const collectWebSockets: Collector = async (ctx) => {
  const result = { files: {} as Record<string, string>, warnings: [] as string[] };
  const redact = ctx.settings.redact;
  const probe = ctx.shared.probe ?? [];

  let connections = 0;
  let frames = 0;
  const perFrame = probe
    .filter((f) => f.ws.length)
    .map((f) => {
      connections += f.ws.length;
      return {
        frameUrl: f.frameUrl || (f.isTop ? ctx.url : undefined),
        connections: (f.ws as WsConnection[]).map((c) => {
          frames += c.frames.length;
          return {
            kind: c.kind,
            url: c.url,
            protocols: c.protocols,
            openedAt: new Date(c.openedAt).toISOString(),
            closedAt: c.closedAt ? new Date(c.closedAt).toISOString() : undefined,
            closeCode: c.closeCode,
            closeReason: c.closeReason,
            frameCount: c.frames.length,
            framesDropped: c.framesDropped,
            frames: c.frames.map((fr) => ({
              dir: fr.dir,
              time: new Date(fr.ts).toISOString(),
              opcode: fr.opcode,
              binaryByteLength: fr.binaryByteLength,
              text: redact && fr.text !== undefined ? redactTokensInString(fr.text) : fr.text,
              truncated: fr.truncated,
            })),
          };
        }),
      };
    });

  result.files['network/websockets.json'] = json({
    note: 'WebSocket and EventSource connections captured in the page from document_start. Server→client messages appear as received frames; only frames the page actually received/sent are visible.',
    summary: { connections, frames },
    frames: perFrame,
  });

  if (!probe.length) result.warnings.push('No WebSocket/EventSource data (probe missing). Use "Record & reload" or reload with the extension installed.');
  else if (!connections) result.warnings.push('No WebSocket or EventSource connections were observed.');
  return result;
};
