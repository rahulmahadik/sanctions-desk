import { createReadStream } from "node:fs";
import { SaxesParser } from "saxes";

/**
 * Streaming XML reader for very large files.
 *
 * The OFAC advanced file is over 100 MB, so it is never loaded as a whole tree. The reader calls a
 * handler for every element whose name is in `recordNames`, handing over just that element as a small
 * tree, then forgets it. Memory stays flat however large the file is.
 */

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Text directly inside this element, trimmed. */
  text: string;
}

/** First child with this name, if any. */
export function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return node?.children.find((c) => c.name === name);
}

/** All children with this name. */
export function children(node: XmlNode | undefined, name: string): XmlNode[] {
  return node ? node.children.filter((c) => c.name === name) : [];
}

/** Text of a child element, or undefined when it is missing or empty. */
export function textOf(node: XmlNode | undefined, name: string): string | undefined {
  const value = child(node, name)?.text;
  return value === undefined || value === "" ? undefined : value;
}

export interface StreamOptions {
  /** Names of elements to hand to `onRecord`. Records do not nest: the outermost match wins. */
  recordNames: ReadonlySet<string>;
  onRecord: (node: XmlNode) => void;
  /** Called with the attributes and name of the root element. */
  onRoot?: (name: string, attrs: Record<string, string>) => void;
}

export class XmlParseError extends Error {
  constructor(message: string) {
    super(`XML parse error: ${message}`);
    this.name = "XmlParseError";
  }
}

/** Parse XML text from memory. Used for tests and small files. */
export function parseXmlString(xml: string, options: StreamOptions): void {
  const parser = createParser(options);
  parser.write(xml).close();
}

/** Parse an XML file as a stream. */
export async function parseXmlFile(path: string, options: StreamOptions): Promise<void> {
  const parser = createParser(options);
  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 1 << 20 });
  for await (const chunk of stream) parser.write(chunk as string);
  parser.close();
}

function createParser(options: StreamOptions): SaxesParser {
  const parser = new SaxesParser();
  const stack: XmlNode[] = [];
  let depthInRecord = 0;
  let rootSeen = false;

  parser.on("error", (err) => {
    throw new XmlParseError(err.message);
  });

  parser.on("opentag", (tag) => {
    const attrs: Record<string, string> = {};
    for (const [key, value] of Object.entries(tag.attributes)) attrs[key] = String(value);
    if (!rootSeen) {
      rootSeen = true;
      options.onRoot?.(tag.name, attrs);
    }
    if (depthInRecord > 0 || options.recordNames.has(tag.name)) {
      const node: XmlNode = { name: tag.name, attrs, children: [], text: "" };
      stack[stack.length - 1]?.children.push(node);
      stack.push(node);
      depthInRecord += 1;
    }
  });

  parser.on("text", (text) => {
    const top = stack[stack.length - 1];
    if (top) top.text += text;
  });

  parser.on("cdata", (text) => {
    const top = stack[stack.length - 1];
    if (top) top.text += text;
  });

  parser.on("closetag", () => {
    if (depthInRecord === 0) return;
    const node = stack.pop() as XmlNode;
    node.text = node.text.trim();
    depthInRecord -= 1;
    if (depthInRecord === 0) options.onRecord(node);
  });

  return parser;
}
