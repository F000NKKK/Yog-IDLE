import { useMemo } from "react";
import { Tree, useT, type TreeNode } from "substrate-platform-ui";
import { useActiveDesigner } from "../designer/activeDesigner";
import { isContainer, type YuiNode } from "../designer/yui";

function toTree(node: YuiNode): TreeNode<YuiNode> {
  return {
    id: node.uid,
    label: node.attrs.id ? `${node.attrs.id} (${node.kind})` : node.kind,
    children: isContainer(node) ? node.children.map(toTree) : undefined,
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
      if (isContainer(n)) ids.add(n.uid);
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
