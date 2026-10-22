import { describe, expect, it } from "vitest";
import { child, children, parseXmlString, textOf, type XmlNode, XmlParseError } from "../src/xml.js";

const collect = (
  xml: string,
  names: string[],
): { nodes: XmlNode[]; root?: string; rootAttrs?: Record<string, string> } => {
  const nodes: XmlNode[] = [];
  let root: string | undefined;
  let rootAttrs: Record<string, string> | undefined;
  parseXmlString(xml, {
    recordNames: new Set(names),
    onRecord: (n) => nodes.push(n),
    onRoot: (name, attrs) => {
      root = name;
      rootAttrs = attrs;
    },
  });
  return { nodes, root, rootAttrs };
};

describe("streaming XML reader", () => {
  const xml = `<?xml version="1.0"?>
<Root xmlns="urn:test" version="3">
  <Skip><Ignored>no</Ignored></Skip>
  <Item id="1"><Name>Alpha &amp; Co</Name><Tag>a</Tag><Tag>b</Tag><Empty/></Item>
  <Item id="2"><Name><![CDATA[Beta <raw>]]></Name></Item>
</Root>`;

  it("hands over each record as a small tree and reports the root", () => {
    const { nodes, root, rootAttrs } = collect(xml, ["Item"]);
    expect(root).toBe("Root");
    expect(rootAttrs).toMatchObject({ version: "3" });
    expect(nodes.map((n) => n.attrs.id)).toEqual(["1", "2"]);
    expect(textOf(nodes[0], "Name")).toBe("Alpha & Co");
    expect(children(nodes[0], "Tag").map((t) => t.text)).toEqual(["a", "b"]);
    expect(textOf(nodes[0], "Empty")).toBeUndefined();
    expect(textOf(nodes[1], "Name")).toBe("Beta <raw>");
    expect(child(nodes[0], "Missing")).toBeUndefined();
  });

  it("ignores elements outside the records and keeps the outermost record whole", () => {
    const nested = collect("<R><Item><Item>inner</Item></Item></R>", ["Item"]);
    expect(nested.nodes).toHaveLength(1);
    expect(children(nested.nodes[0], "Item")[0]?.text).toBe("inner");
    expect(collect(xml, ["Nothing"]).nodes).toEqual([]);
  });

  it("reports malformed XML", () => {
    expect(() => collect("<R><Item></R>", ["Item"])).toThrow(XmlParseError);
  });

  it("returns empty results for missing nodes", () => {
    expect(child(undefined, "x")).toBeUndefined();
    expect(children(undefined, "x")).toEqual([]);
    expect(textOf(undefined, "x")).toBeUndefined();
  });
});
