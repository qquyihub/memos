/**
 * Markdown metadata extraction aligned with the upstream Memos v0.28
 * `internal/markdown` service (goldmark-based tag, mention and property
 * extraction). We do not render markdown here; we only derive the metadata
 * that the API stores in `memo.payload`.
 */

const MAX_TAG_RUNES = 100;
const MAX_MENTION_RUNES = 32;
const SNIPPET_LENGTH = 64;

const TAG_RUNE_RE = /[\p{L}\p{N}\p{M}\p{S}\u200D_\-/&]/u;
const MENTION_RUNE_RE = /[\p{L}\p{N}-]/u;
const MENTION_BOUNDARY_RE = /[\p{P}\p{S}]/u;

export interface MemoPayloadProperty {
  hasLink: boolean;
  hasTaskList: boolean;
  hasCode: boolean;
  hasIncompleteTasks: boolean;
  title: string;
}

export interface MemoPayloadData {
  tags: string[];
  property: MemoPayloadProperty;
  mentions: string[];
}

interface SanitizedContent {
  /** Content without fenced/indented code blocks and inline code spans. */
  text: string;
  hasCode: boolean;
}

function sanitizeMarkdown(content: string): SanitizedContent {
  const lines = content.split("\n");
  const output: string[] = [];
  let fence: { marker: string; length: number } | null = null;
  let hasCode = false;

  for (const line of lines) {
    if (fence) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith(fence.marker.repeat(fence.length))) {
        fence = null;
      }
      continue;
    }

    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      fence = { marker: fenceMatch[1][0], length: fenceMatch[1].length };
      hasCode = true;
      output.push("");
      continue;
    }

    if (/^(\t| {4})/.test(line)) {
      hasCode = true;
      output.push("");
      continue;
    }

    let sanitized = line;
    if (sanitized.includes("`")) {
      const withoutInlineCode = sanitized.replace(/`+[^`]*`+/g, " ");
      if (withoutInlineCode !== sanitized) {
        hasCode = true;
        sanitized = withoutInlineCode;
      }
    }
    output.push(sanitized);
  }

  return { text: output.join("\n"), hasCode };
}

function pushUnique(list: string[], value: string) {
  if (!list.includes(value)) {
    list.push(value);
  }
}

export function extractTags(content: string): string[] {
  const { text } = sanitizeMarkdown(content);
  const tags: string[] = [];

  for (const line of text.split("\n")) {
    for (let index = 0; index < line.length; index += 1) {
      if (line[index] !== "#") continue;

      // A leading `# ` or `#` is a heading marker, not a tag. `##foo` still
      // exposes `foo` as a tag in upstream because the second `#` is inline.
      if (index === 0 && (line[1] === "#" || line[1] === " ")) {
        continue;
      }

      let cursor = index + 1;
      let runeCount = 0;
      let tag = "";
      while (cursor < line.length && runeCount < MAX_TAG_RUNES) {
        const codePoint = line.codePointAt(cursor)!;
        const rune = String.fromCodePoint(codePoint);
        if (!TAG_RUNE_RE.test(rune)) break;
        tag += rune;
        runeCount += 1;
        cursor += rune.length;
      }

      if (tag) {
        pushUnique(tags, tag);
        index = cursor - 1;
      }
    }
  }

  return tags;
}

export function extractMentions(content: string): string[] {
  const { text } = sanitizeMarkdown(content);
  const mentions: string[] = [];

  for (const line of text.split("\n")) {
    for (let index = 0; index < line.length; index += 1) {
      if (line[index] !== "@") continue;

      const previous = index > 0 ? line[index - 1] : "\n";
      if (previous !== "\n" && !/\s/.test(previous) && !MENTION_BOUNDARY_RE.test(previous)) {
        continue;
      }

      let cursor = index + 1;
      let runeCount = 0;
      let hasLetterOrNumber = false;
      let username = "";
      while (cursor < line.length && runeCount < MAX_MENTION_RUNES) {
        const codePoint = line.codePointAt(cursor)!;
        const rune = String.fromCodePoint(codePoint);
        if (!MENTION_RUNE_RE.test(rune)) break;
        if (/\p{L}|\p{N}/u.test(rune)) {
          hasLetterOrNumber = true;
        }
        username += rune;
        runeCount += 1;
        cursor += rune.length;
      }

      if (username && hasLetterOrNumber) {
        pushUnique(mentions, username);
        index = cursor - 1;
      }
    }
  }

  return mentions;
}

function stripHeadingFormatting(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/[*_~]{1,3}/g, "")
    .replace(/\s+#+\s*$/, "")
    .trim();
}

function extractTitle(content: string): string {
  const firstNonEmptyLine = content.split("\n").find((line) => line.trim() !== "");
  if (!firstNonEmptyLine) {
    return "";
  }
  if (/^ {0,3}(`{3,}|~{3,})/.test(firstNonEmptyLine)) {
    return "";
  }

  const headingMatch = firstNonEmptyLine.match(/^ {0,3}#\s+(.+)$/);
  if (!headingMatch) {
    return "";
  }
  return stripHeadingFormatting(headingMatch[1]);
}

export function extractMemoPayloadData(content: string): MemoPayloadData {
  const sanitized = sanitizeMarkdown(content);
  const text = sanitized.text;

  const hasLink = /https?:\/\/|www\.[^\s]+|[^!]\[[^\]]*\]\([^)]*\)/i.test(text);
  const taskListMatches = text.match(/[ \t]*[-*+]\s+\[[ xX]\]/g) ?? [];
  const hasTaskList = taskListMatches.length > 0;
  const hasIncompleteTasks = taskListMatches.some((match) => /\[ \]/.test(match));

  return {
    tags: extractTags(content),
    mentions: extractMentions(content),
    property: {
      hasLink,
      hasTaskList,
      hasCode: sanitized.hasCode,
      hasIncompleteTasks,
      title: extractTitle(content),
    },
  };
}

export function buildMemoSnippet(content: string, limit = SNIPPET_LENGTH): string {
  return content.replace(/\s+/g, " ").trim().slice(0, limit);
}
