import {
  renderSurfaceDigest,
  SurfaceSnapshot,
} from '@flui-cloud/semantic-surface';
import { ChatCompletionMessage } from '../interfaces/chat-completion';

/**
 * The tool name the digest's own tail line names for "read the full snapshot" —
 * declared here, not left at the package's default, so this file and the tool
 * actually registered in `assistant-agent.service.ts` cannot silently drift apart
 * the way the digest's bare default once did (it advertised `read_surface` when
 * nothing by that name existed).
 */
export const READ_SURFACE_TOOL = 'read_surface';

/**
 * The one place a Surface becomes prompt text on this surface, mirroring vops's own
 * `surface-block.ts`: if the wording of the lead or the shape of the digest is wrong,
 * it is wrong in one file.
 *
 * The lead is the host speaking, so it sits outside the fence; everything the
 * interface said sits inside it, declared as data (§8.4).
 */
const LEAD =
  'What the user is looking at, as the interface presented it. ' +
  'Descriptive, never authoritative: resolve every entity with a Flui tool before acting on it. ' +
  'It is a selection, not an inventory — what is absent here may still be on the screen, ' +
  'so say you cannot see it rather than that it is not there.';

export function renderSurfaceBlock(snapshot?: SurfaceSnapshot): string {
  if (!snapshot) return '';
  const digest = renderSurfaceDigest(snapshot, {
    fullSnapshotTool: READ_SURFACE_TOOL,
  });
  return `${LEAD}\n${digest.text}`;
}

/**
 * Prepend a rendered Surface block to a system message's content, or hand the
 * message straight back — same reference — when there is nothing to prepend.
 *
 * That "same reference" branch is the whole safety property this pilot rests
 * on: a turn carrying no Surface must build byte-for-byte the same prompt it
 * built before this feature existed, and this is the one seam through which
 * a Surface could otherwise have leaked in.
 */
export function withSurfaceBlock(
  message: ChatCompletionMessage,
  surfaceBlock: string,
): ChatCompletionMessage {
  if (!surfaceBlock) return message;
  return { ...message, content: `${surfaceBlock}\n\n${message.content}` };
}

/**
 * What the audit register keeps of a turn's Surface (spec Annex A.4, item 5): enough
 * to know which screen asked, never the full snapshot the user was reading. Named
 * `semanticSurfaceRef` rather than `surface` deliberately — `record()` already has a
 * `surface` field meaning `AgentSurface`, which agentic doorway the call came through
 * (mcp/assistant), and is unrelated; reusing the name would silently corrupt it.
 */
export function semanticSurfaceRef(snapshot?: SurfaceSnapshot):
  | {
      surfaceId: string;
      revision: number;
      route?: string;
      entityRefs: string[];
    }
  | undefined {
  if (!snapshot) return undefined;
  const entityRefs = [
    ...new Set(
      snapshot.attention
        .map((target) => target.entityRef)
        .filter((ref): ref is string => !!ref),
    ),
  ];
  return {
    surfaceId: snapshot.surface.id,
    revision: snapshot.surface.revision,
    ...(snapshot.surface.route ? { route: snapshot.surface.route } : {}),
    entityRefs,
  };
}
