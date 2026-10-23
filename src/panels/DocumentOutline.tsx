import { useMemo } from "react";
import { yui } from "../data/yogIds.generated";
import { Tree, useT, type TreeNode } from "substrate-platform-ui";
import { useActiveDesigner } from "../designer/view/activeDesigner";
import { isComponentDoc } from "../designer/model/components";
import { isContainer, isPropertyElement, type YuiNode } from "../designer/model/yui";

/** Has children in the outline: containers, and a component document's root (declarations + body). */
const branches = (n: YuiNode) => isContainer(n) || isComponentDoc(n);

function toTree(node: YuiNode): TreeNode<YuiNode> {
  const named = node.attrs.id ?? (node.kind === yui.COMPONENT || node.kind === yui.PROPERTY || node.kind === yui.EVENT ? node.attrs.name : undefined);
  return {
    id: node.uid,
    label: named ? `${named} (${node.kind})` : node.kind,
    children: branches(node) ? node.children.filter((c) => !isPropertyElement(c)).map(toTree) : undefined,
    data: node,
  };
}

/** Visual Studio's Document Outline: the open screen's widget tree, selection shared with the designer. */
export function DocumentOutline() {
  const t = useT();
  const designer = useActiveDesigner();
  const nodes = useMemo(() => (designer ? [toTree(designer.doc.root)] : []), [designer]);
  const expanded = useMemo(() => {
    const ids = new Set<string>();
    const visit = (n: YuiNode) => {
      if (branches(n)) ids.add(n.uid);
      n.children.forEach(visit);
    };
    if (designer) visit(designer.doc.root);
    return ids;
  }, [designer]);
  if (!designer)
    return (
      <div className="panel-placeholder">
        <p>{t("Open a .yui screen in the designer to see its outline.")}</p>
      </div>
    );
  return (
    <Tree
      key={designer.path}
      nodes={nodes}
      defaultExpandedIds={expanded}
      selectedIds={new Set(designer.selection)}
      onSelectionChange={(ids) => designer.select([...ids])}
      onActivate={() => designer.focus()}
    />
  );
}
