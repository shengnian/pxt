///<reference path='../localtypings/pxtblockly.d.ts'/>
/// <reference path="../built/pxtlib.d.ts" />

namespace pxt.blocks {
    export function saveWorkspaceXml(ws: Blockly.Workspace): string {
        let xml = Blockly.Xml.workspaceToDom(ws, true);
        let text = Blockly.Xml.domToPrettyText(xml);
        return text;
    }

    export function getDirectChildren(parent: Element, tag: string) {
        const res: Element[] = [];
        for (let i = 0; i < parent.childNodes.length; i++) {
            const n = parent.childNodes.item(i) as Element;
            if (n.tagName === tag) {
                res.push(n);
            }
        }
        return res;
    }

    export function getBlocksWithType(parent: Document | Element, blockType: string) {
        return getChildrenWithAttr(parent, "block", "type", blockType);
    }

    export function getChildrenWithAttr(parent:  Document | Element, tag: string, attr: string, value: string) {
        return Util.toArray(parent.getElementsByTagName(tag)).filter(b => b.getAttribute(attr) === value);
    }

    export function getFirstChildWithAttr(parent:  Document | Element, tag: string, attr: string, value: string) {
        const res = getChildrenWithAttr(parent, tag, attr, value);
        return res.length ? res[0] : undefined;
    }

    /**
     * Loads the xml into a off-screen workspace (not suitable for size computations)
     */
    export function loadWorkspaceXml(xml: string, skipReport = false) {
        const workspace = new Blockly.Workspace();
        try {
            const dom = Blockly.Xml.textToDom(xml);
            Blockly.Xml.domToWorkspace(dom, workspace);
            return workspace;
        } catch (e) {
            if (!skipReport)
                pxt.reportException(e);
            return null;
        }
    }

    function patchFloatingBlocks(dom: Element, info: pxtc.BlocksInfo) {
        const onstarts = getBlocksWithType(dom, ts.pxtc.ON_START_TYPE);
        let onstart = onstarts.length ? onstarts[0] : undefined;
        if (onstart) { // nothing to do
            onstart.removeAttribute("deletable");
            return;
        }

        let newnodes: Element[] = [];

        const blocks: Map<pxtc.SymbolInfo> = info.blocksById;

        // walk top level blocks
        let node = dom.firstElementChild;
        let insertNode: Element = undefined;
        while (node) {
            const nextNode = node.nextElementSibling;
            // does this block is disable or have s nested statement block?
            const nodeType = node.getAttribute("type");
            if (!node.getAttribute("disabled") && !node.getElementsByTagName("statement").length
                && (pxt.blocks.buildinBlockStatements[nodeType] ||
                    (blocks[nodeType] && blocks[nodeType].retType == "void" && !hasArrowFunction(blocks[nodeType])))
            ) {
                // old block, needs to be wrapped in onstart
                if (!insertNode) {
                    insertNode = dom.ownerDocument.createElement("statement");
                    insertNode.setAttribute("name", "HANDLER");
                    if (!onstart) {
                        onstart = dom.ownerDocument.createElement("block");
                        onstart.setAttribute("type", ts.pxtc.ON_START_TYPE);
                        newnodes.push(onstart);
                    }
                    onstart.appendChild(insertNode);
                    insertNode.appendChild(node);

                    node.removeAttribute("x");
                    node.removeAttribute("y");
                    insertNode = node;
                } else {
                    // event, add nested statement
                    const next = dom.ownerDocument.createElement("next");
                    next.appendChild(node);
                    insertNode.appendChild(next);
                    node.removeAttribute("x");
                    node.removeAttribute("y");
                    insertNode = node;
                }
            }
            node = nextNode;
        }

        newnodes.forEach(n => dom.appendChild(n));
    }

    /**
     * This callback is populated from the editor extension result.
     * Allows a target to provide version specific blockly updates
     */
    export let extensionBlocklyPatch: (pkgTargetVersion: string, dom: Element) => void;

    export function importXml(pkgTargetVersion: string, xml: string, info: pxtc.BlocksInfo, skipReport = false): string {
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(xml, "application/xml");

            const upgrades = pxt.patching.computePatches(pkgTargetVersion);
            if (upgrades) {
                // patch block types
                upgrades.filter(up => up.type == "blockId")
                    .forEach(up => Object.keys(up.map).forEach(blockType => {
                        getBlocksWithType(doc, blockType)
                            .forEach(blockNode => {
                                blockNode.setAttribute("type", up.map[blockType]);
                                pxt.debug(`patched block ${blockType} -> ${up.map[blockType]}`);
                            });
                    }))

                // patch block value
                upgrades.filter(up => up.type == "blockValue")
                    .forEach(up => Object.keys(up.map).forEach(k => {
                        const m = k.split('.');
                        const blockType = m[0];
                        const name = m[1];
                        getBlocksWithType(doc, blockType)
                            .reduce<Element[]>((prev, current) => prev.concat(getDirectChildren(current, "value")), [])
                            .forEach(blockNode => {
                                blockNode.setAttribute("name", up.map[k]);
                                pxt.debug(`patched block value ${k} -> ${up.map[k]}`);
                            });
                    }))
            }

            // build upgrade map
            const enums: Map<string> = {};
            Object.keys(info.apis.byQName).forEach(k => {
                let api = info.apis.byQName[k];
                if (api.kind == pxtc.SymbolKind.EnumMember)
                    enums[api.namespace + '.' + (api.attributes.blockImportId || api.attributes.block || api.attributes.blockId || api.name)]
                        = api.namespace + '.' + api.name;
            })

            // walk through blocks and patch enums
            const blocks = doc.getElementsByTagName("block");
            for (let i = 0; i < blocks.length; ++i)
                patchBlock(info, enums, blocks[i]);

            // patch floating blocks
            patchFloatingBlocks(doc.documentElement, info);

            // apply extension patches
            if (pxt.blocks.extensionBlocklyPatch)
                pxt.blocks.extensionBlocklyPatch(pkgTargetVersion, doc.documentElement);

            // serialize and return
            return new XMLSerializer().serializeToString(doc);
        }
        catch (e) {
            if (!skipReport)
                reportException(e);
            return xml;
        }
    }

    function patchBlock(info: pxtc.BlocksInfo, enums: Map<string>, block: Element): void {
        let blockType = block.getAttribute("type");
        let b = Blockly.Blocks[blockType];
        let symbolInfo = blockSymbol(blockType);
        if (!symbolInfo || !b) return;

        let comp = compileInfo(symbolInfo);
        symbolInfo.parameters.forEach((p, i) => {
            let ptype = info.apis.byQName[p.tsType];
            if (ptype && ptype.kind == pxtc.SymbolKind.Enum) {
                let field = getFirstChildWithAttr(block, "field", "name", comp.actualNameToParam[p.name].definitionName);
                if (field) {
                    let en = enums[ptype.name + '.' + field.textContent];
                    if (en) field.textContent = en;
                }
                /*
<block type="device_button_event" x="92" y="77">
    <field name="NAME">Button.AB</field>
  </block>
                  */
            }
        })
    }
}
